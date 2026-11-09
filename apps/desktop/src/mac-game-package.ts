import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { isValidAppId } from "@haptic/core/app-identity";
import { gameAppFiles, macGameNames } from "../../../packages/exporter/src/native-desktop";

/**
 * Packages a macOS game on a Mac from Electron's official Apple Silicon
 * runtime with Apple's own tools: `ditto` unpacks and archives (keeping
 * symlinks and signatures), `plutil` sets the app's identity, `codesign`
 * signs it ad-hoc or with a Developer ID from this Mac's keychain, and
 * `notarytool` and `stapler` notarize it with a keychain profile the user
 * created. Haptic never handles Apple credentials.
 */

/** Runs a program without a shell; `cwd` and `env` default to this process's. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export const runCommand: RunCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout).trim() || error.message, { cause: error }));
    else resolve({ stdout, stderr });
  });
});

/** Developer ID Application identities in this Mac's keychain, as codesign names them. */
export async function macSigningIdentities(run: RunCommand = runCommand): Promise<string[]> {
  const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  return [...stdout.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"(Developer ID Application: [^"\n]+)"\s*$/gm)].map((match) => match[1]!);
}

export interface MacGamePackageRequest {
  /** The exported web game: path and bytes. */
  game: [string, Uint8Array][];
  /** Name under the icon and in the menu bar. */
  name: string;
  appId: string;
  version: string;
  buildNumber: number;
  /** Stable per project; names the game's storage folder. */
  gameId: string;
  /** The App Icon as an `.icns`, written over Electron's (`CFBundleIconFile` names `electron.icns`); null keeps Electron's. */
  icon: Uint8Array | null;
  /** A Developer ID Application identity, or null for ad-hoc signing. */
  identity: string | null;
  /** notarytool keychain profile; empty skips notarization. */
  notaryProfile: string;
}

export interface MacGamePackage {
  fileName: string;
  bytes: Uint8Array;
  notarized: boolean;
}

/** Hardened-runtime exceptions Electron's V8 and helpers need (as electron-builder grants). */
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`;


const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

async function isMachO(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGIC.has(header.readUInt32BE(0));
  } finally {
    await file.close();
  }
}

/**
 * Code inside `app` that is signed before it, deepest first, as Apple
 * requires: nested `.app` and `.framework` bundles, and Mach-O files outside
 * them. Symlinks (a framework's `Versions/Current`) are never followed.
 */
export async function nestedCode(app: string): Promise<string[]> {
  const found: string[] = [];
  const mainExecutable = join(app, "Contents", "MacOS");
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (name === "_CodeSignature") continue;
        await walk(path);
        if (name.endsWith(".app") || name.endsWith(".framework")) found.push(path);
      } else if (stat.isFile() && dirname(path) !== mainExecutable && await isMachO(path)) {
        found.push(path);
      }
    }
  };
  await walk(join(app, "Contents"));
  const depth = (path: string) => relative(app, path).split(sep).length;
  return found.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/** The helper bundle ID Electron's packagers use: `<appId>.helper`, `.helper.GPU`, `.helper.Renderer`, `.helper.Plugin`. */
export function helperBundleId(appId: string, helperName: string): string {
  const kind = /\(([^)]+)\)\.app$/.exec(helperName)?.[1]?.replace(/[^A-Za-z0-9]/g, "");
  return kind ? `${appId}.helper.${kind}` : `${appId}.helper`;
}

/** A path under `root` for a package file, refusing anything that leaves it. */
export function within(root: string, path: string): string {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid game file path: ${path}`);
  }
  return join(root, ...path.split("/"));
}

export async function packageMacGame(options: {
  request: MacGamePackageRequest;
  /** Electron's official darwin-arm64 release zip, already checked against its SHA-256. */
  runtime: Uint8Array;
  /** The game host's `main.cjs`. */
  host: Uint8Array;
  run?: RunCommand;
  /** Signing identities this Mac offers; a requested identity must be one of them. */
  identities?: () => Promise<string[]>;
}): Promise<MacGamePackage> {
  const { request } = options;
  const run = options.run ?? runCommand;
  if (!isValidAppId(request.appId)) throw new Error(`App ID ${request.appId} is not valid. Set it in Project Settings > Export.`);
  if (request.identity && !(await (options.identities ?? (() => macSigningIdentities(run)))()).includes(request.identity)) {
    throw new Error(`The signing identity ${request.identity} is not in this Mac's keychain. Choose another in Engine Settings > Packaging.`);
  }
  const names = macGameNames(request.name);
  const name = names.app;
  const work = await mkdtemp(join(tmpdir(), "haptic-macos-"));
  try {
    const runtimeZip = join(work, "runtime.zip");
    await writeFile(runtimeZip, options.runtime);
    await run("/usr/bin/ditto", ["-x", "-k", runtimeZip, join(work, "runtime")]);
    const out = join(work, "out");
    await mkdir(out);
    const app = join(out, `${name}.app`);
    await rename(join(work, "runtime", "Electron.app"), app);

    const plist = (bundle: string) => join(bundle, "Contents", "Info.plist");
    const set = (file: string, key: string, value: string) => run("/usr/bin/plutil", ["-replace", key, "-string", value, file]);
    await set(plist(app), "CFBundleIdentifier", request.appId);
    await set(plist(app), "CFBundleName", name);
    await set(plist(app), "CFBundleDisplayName", name);
    await set(plist(app), "CFBundleShortVersionString", request.version);
    await set(plist(app), "CFBundleVersion", String(request.buildNumber));
    const frameworks = join(app, "Contents", "Frameworks");
    for (const helper of (await readdir(frameworks)).filter((entry) => entry.endsWith(".app")).sort()) {
      await set(plist(join(frameworks, helper)), "CFBundleIdentifier", helperBundleId(request.appId, helper));
    }

    const resources = join(app, "Contents", "Resources");
    await rm(join(resources, "default_app.asar"), { force: true });
    // Before signing: the icon is part of the sealed bundle.
    if (request.icon) await writeFile(join(resources, "electron.icns"), request.icon);
    const command = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
    const files = gameAppFiles(
      { host: options.host, game: new Map(request.game), name: request.name, version: request.version, gameId: request.gameId },
      { executable: command },
    );
    // The list is relative to a Windows or Linux game's folder; on macOS `Contents/Resources` is its `resources`.
    for (const [path, data] of files) {
      const target = within(resources, path.replace(/^resources\//, ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }

    if (request.identity) {
      const entitlements = join(work, "entitlements.plist");
      await writeFile(entitlements, ENTITLEMENTS);
      const sign = (path: string) => run("/usr/bin/codesign", [
        "--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", request.identity!, path,
      ]);
      for (const path of await nestedCode(app)) await sign(path);
      await sign(app);
    } else {
      // Ad-hoc: runs on this Mac; other Macs need right-click Open.
      await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    }
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

    const notarize = Boolean(request.identity && request.notaryProfile);
    if (notarize) {
      const upload = join(work, "notarize.zip");
      await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, upload]);
      const { stdout } = await run("/usr/bin/xcrun", ["notarytool", "submit", upload, "--keychain-profile", request.notaryProfile, "--wait", "--output-format", "json"]);
      const result = JSON.parse(stdout) as { id?: string; status?: string; message?: string };
      if (result.status !== "Accepted") {
        throw new Error(`Apple did not notarize the app (${result.status ?? "no status"}). Check with: xcrun notarytool log ${result.id ?? "<id>"} --keychain-profile ${request.notaryProfile}`);
      }
      await run("/usr/bin/xcrun", ["stapler", "staple", app]);
    }

    const archive = join(work, "game.zip");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
    return { fileName: names.archive, bytes: new Uint8Array(await readFile(archive)), notarized: notarize };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
