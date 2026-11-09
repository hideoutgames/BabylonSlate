import { describe, expect, it } from "vitest";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { macGameNames } from "../../../packages/exporter/src/native-desktop";
import { helperBundleId, macSigningIdentities, packageMacGame, type MacGamePackageRequest, type RunCommand } from "./mac-game-package";

const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

/** Electron.app as Electron's darwin release lays it out, trimmed to what packaging touches. */
async function electronApp(root: string): Promise<void> {
  const app = join(root, "Electron.app", "Contents");
  const framework = join(app, "Frameworks", "Electron Framework.framework");
  for (const dir of ["MacOS", "Resources", "Frameworks", "Frameworks/Electron Framework.framework/Versions/A/Libraries"]) await mkdir(join(app, dir), { recursive: true });
  await writeFile(join(app, "Info.plist"), "<plist/>");
  await writeFile(join(app, "MacOS", "Electron"), MACH_O);
  await writeFile(join(app, "Resources", "default_app.asar"), "sample");
  await writeFile(join(app, "Resources", "electron.icns"), "icon");
  await writeFile(join(framework, "Versions", "A", "Electron Framework"), MACH_O);
  await writeFile(join(framework, "Versions", "A", "Libraries", "libffmpeg.dylib"), MACH_O);
  await symlink("A", join(framework, "Versions", "Current"));
  await symlink("Versions/Current/Electron Framework", join(framework, "Electron Framework"));
  for (const helper of ["Electron Helper", "Electron Helper (GPU)"]) {
    await mkdir(join(app, "Frameworks", `${helper}.app`, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(app, "Frameworks", `${helper}.app`, "Contents", "Info.plist"), "<plist/>");
    await writeFile(join(app, "Frameworks", `${helper}.app`, "Contents", "MacOS", helper), MACH_O);
  }
}

function request(overrides: Partial<MacGamePackageRequest> = {}): MacGamePackageRequest {
  return {
    game: [["index.html", new TextEncoder().encode("<html>")], ["assets/data.bin", new Uint8Array([1])]],
    name: "Space Game", appId: "com.studio.spacegame", version: "1.2.0", buildNumber: 7, gameId: "project-guid",
    identity: "Developer ID Application: Studio (TEAM123456)", notaryProfile: "haptic-notary",
    ...overrides,
  };
}

/** Apple's tools, recorded; ditto unpacks the stand-in app and archives a marker; notarytool answers `status`. */
function tools(status = "Accepted") {
  const calls: string[][] = [];
  let resources: string[] = [];
  let workRoot = "";
  const run: RunCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("ditto") && args[0] === "-x") {
      workRoot = join(args[3]!, "..");
      await electronApp(args[3]!);
    }
    if (command.endsWith("ditto") && args[0] === "-c") {
      const app = args[3]!;
      const listing: string[] = [];
      const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else listing.push(relative(app, path)); } };
      await walk(join(app, "Contents", "Resources"));
      resources = listing.sort();
      await writeFile(args[4]!, `zip of ${relative(workRoot, app)}`);
    }
    if (command.endsWith("xcrun") && args[0] === "notarytool") return { stdout: JSON.stringify({ id: "sub-1", status }), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls, resources: () => resources };
}

const shorten = (call: string[]) => call.map((part) => part.replace(/^.*haptic-macos-[^/]+\//, "<work>/"));

describe("macOS game packages", () => {
  it("set the app's identity, sign nested code before the app with the Developer ID, notarize and staple", async () => {
    const apple = tools();
    const result = await packageMacGame({ request: request(), runtime: new Uint8Array([1]), host: new TextEncoder().encode("host();"), run: apple.run,
      identities: async () => ["Developer ID Application: Studio (TEAM123456)"] });

    expect(result.fileName).toBe("Space_Game-macOS.zip");
    expect(new TextDecoder().decode(result.bytes)).toBe("zip of out/Space Game.app");
    expect(result.notarized).toBe(true);
    const calls = apple.calls.map(shorten);
    const plutil = calls.filter((call) => call[0] === "/usr/bin/plutil").map((call) => `${call[2]}=${call[4]} @ ${call[5]!.replace("<work>/out/Space Game.app/", "")}`);
    expect(plutil).toEqual([
      "CFBundleIdentifier=com.studio.spacegame @ Contents/Info.plist",
      "CFBundleName=Space Game @ Contents/Info.plist",
      "CFBundleDisplayName=Space Game @ Contents/Info.plist",
      "CFBundleShortVersionString=1.2.0 @ Contents/Info.plist",
      "CFBundleVersion=7 @ Contents/Info.plist",
      "CFBundleIdentifier=com.studio.spacegame.helper.GPU @ Contents/Frameworks/Electron Helper (GPU).app/Contents/Info.plist",
      "CFBundleIdentifier=com.studio.spacegame.helper @ Contents/Frameworks/Electron Helper.app/Contents/Info.plist",
    ]);
    const signed = calls.filter((call) => call[0] === "/usr/bin/codesign" && call[1] === "--force").map((call) => call.at(-1)!.replace("<work>/out/Space Game.app", "@"));
    // Deepest first, symlinks never, the app last; each with the hardened runtime and a timestamp.
    expect(signed).toEqual([
      "@/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
      "@/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "@/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)",
      "@/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper",
      "@/Contents/Frameworks/Electron Framework.framework",
      "@/Contents/Frameworks/Electron Helper (GPU).app",
      "@/Contents/Frameworks/Electron Helper.app",
      "@",
    ]);
    expect(calls.find((call) => call[0] === "/usr/bin/codesign")!.slice(1, 6)).toEqual(["--force", "--timestamp", "--options", "runtime", "--entitlements"]);
    const order = calls.map((call) => `${call[0]!.split("/").pop()} ${call[1]}`);
    expect(order.slice(-6)).toEqual(["codesign --force", "codesign --verify", "ditto -c", "xcrun notarytool", "xcrun stapler", "ditto -c"]);
    expect(calls.find((call) => call[1] === "notarytool")).toEqual(["/usr/bin/xcrun", "notarytool", "submit", "<work>/notarize.zip", "--keychain-profile", "haptic-notary", "--wait", "--output-format", "json"]);
    // The game host reads process.resourcesPath, which is Contents/Resources on macOS.
    expect(apple.resources()).toEqual([
      "Contents/Resources/app/main.cjs", "Contents/Resources/app/package.json", "Contents/Resources/electron.icns",
      "Contents/Resources/game/assets/data.bin", "Contents/Resources/game/index.html",
    ]);
  });

  it("sign ad-hoc without notarizing when no identity is chosen", async () => {
    const apple = tools();
    const result = await packageMacGame({ request: request({ identity: null }), runtime: new Uint8Array([1]), host: new Uint8Array(), run: apple.run });
    expect(result.notarized).toBe(false);
    const codesign = apple.calls.filter((call) => call[0] === "/usr/bin/codesign").map((call) => call.slice(1, 5).join(" "));
    expect(codesign).toEqual(["--force --deep --sign -", "--verify --deep --strict " + apple.calls.find((call) => call[1] === "--verify")![4]]);
    expect(apple.calls.some((call) => call[0] === "/usr/bin/xcrun")).toBe(false);
  });

  it("refuse an identity this Mac lacks, an invalid App ID and an app Apple rejects", async () => {
    const apple = tools("Invalid");
    await expect(packageMacGame({ request: request(), runtime: new Uint8Array(), host: new Uint8Array(), run: apple.run, identities: async () => [] }))
      .rejects.toThrow("is not in this Mac's keychain");
    await expect(packageMacGame({ request: request({ appId: "com.my-studio.game" }), runtime: new Uint8Array(), host: new Uint8Array(), run: apple.run }))
      .rejects.toThrow("App ID com.my-studio.game is not valid. Set it in Project Settings > Export.");
    expect(apple.calls).toEqual([]);
    await expect(packageMacGame({ request: request(), runtime: new Uint8Array(), host: new Uint8Array(), run: apple.run,
      identities: async () => ["Developer ID Application: Studio (TEAM123456)"] })).rejects.toThrow("Apple did not notarize the app (Invalid). Check with: xcrun notarytool log sub-1 --keychain-profile haptic-notary");
  });

  it("list only Developer ID Application identities and name helpers' bundle IDs as Electron's packagers do", async () => {
    const output = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: dev@example.com (ABCDE12345)"',
      '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Studio (TEAM123456)"',
      "     2 valid identities found",
    ].join("\n");
    expect(await macSigningIdentities(async () => ({ stdout: output, stderr: "" }))).toEqual(["Developer ID Application: Studio (TEAM123456)"]);
    expect(helperBundleId("com.a.b", "Electron Helper (Renderer).app")).toBe("com.a.b.helper.Renderer");
    expect(helperBundleId("com.a.b", "Electron Helper.app")).toBe("com.a.b.helper");
    expect(macGameNames("Rocket: Run/2")).toEqual({ app: "Rocket Run2", archive: "Rocket_Run2-macOS.zip" });
  });
});
