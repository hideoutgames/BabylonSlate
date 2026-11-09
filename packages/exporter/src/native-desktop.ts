import { zipSync, type Zippable } from "fflate";
import type { AppIconImages } from "./app-icon";
import { SAFE_ZIP_MTIME } from "./zip-time";
import { readZipEntries, readZipEntryData, writeZip, type ZipCopy } from "./zip-merge";

/** Desktop platforms a web game can be packaged for, as `<platform>-<arch>`. */
export const DESKTOP_GAME_TARGETS = ["windows-x64", "linux-x64"] as const;
export type DesktopGameTarget = (typeof DESKTOP_GAME_TARGETS)[number];

export interface DesktopGamePackageInput {
  target: DesktopGameTarget;
  /** Electron's runtime for the target, laid out as its official release zip. */
  runtime: Uint8Array;
  /** The game host's bundled main process, written as `resources/app/main.cjs`. */
  host: Uint8Array;
  /** The exported web game (`ExportArtifact.files`), served from `resources/game/`. */
  game: ReadonlyMap<string, Uint8Array>;
  /** Project name: the folder, window and executable name. */
  name: string;
  version: string;
  /** Stable per project; names the game's own storage folder, so saves survive renames. */
  gameId: string;
  /**
   * Project Settings App Icon: the Debian package's menu icon and, through
   * `packageWindowsGame`, the Windows executable's. The game window shows the
   * export's `icon.png` on every platform.
   */
  icon?: AppIconImages;
}

export interface DesktopGameNames {
  /** Top-level folder inside the ZIP. */
  folder: string;
  executable: string;
  /** Saved file name, like the web package's (`My_Game-Windows.zip`). */
  archive: string;
}

const RUNTIME_EXECUTABLE: Record<DesktopGameTarget, string> = { "windows-x64": "electron.exe", "linux-x64": "electron" };
const TARGET_LABEL: Record<DesktopGameTarget, string> = { "windows-x64": "Windows", "linux-x64": "Linux" };
/** Characters Windows refuses in file names (control characters are dropped too). */
const WINDOWS_RESERVED = '<>:"/\\|?*';
/** Electron's sample app, which the game host replaces. */
const DEFAULT_APP = "resources/default_app.asar";

/** Names for a project's package: Windows keeps the name as typed; Linux runs a lowercase-dashed command. */
export function desktopGameNames(projectName: string, target: DesktopGameTarget): DesktopGameNames {
  const name = projectName.trim() || "Game";
  // Characters Windows refuses in file names, and the trailing dots and spaces it drops.
  const folder = [...name].filter((character) => character.charCodeAt(0) >= 32 && !WINDOWS_RESERVED.includes(character)).join("")
    .replace(/[. ]+$/, "").trim() || "Game";
  const command = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
  return {
    folder,
    executable: target === "windows-x64" ? `${folder}.exe` : command,
    archive: `${folder.replace(/\s+/g, "_")}-${TARGET_LABEL[target]}.zip`,
  };
}

/** A macOS app's name (as Finder and the menu bar show it) and its saved ZIP, from the app's display name. */
export function macGameNames(displayName: string): { app: string; archive: string } {
  const app = [...displayName].filter((character) => character.charCodeAt(0) >= 32 && character !== "/" && character !== ":").join("")
    .replace(/^\.+/, "").trim().slice(0, 100) || "Game";
  return { app, archive: `${app.replace(/\s+/g, "_")}-macOS.zip` };
}

/** The release's executable name, checked to be in the runtime. */
export function runtimeExecutable(target: DesktopGameTarget, entries: readonly { name: string }[]): string {
  const executable = RUNTIME_EXECUTABLE[target];
  if (!entries.some((entry) => entry.name === executable)) {
    throw new Error(`The ${TARGET_LABEL[target]} player is damaged: ${executable} is missing.`);
  }
  return executable;
}

/** Whether a runtime entry is left out of a game: Electron's sample app, which the game host replaces. */
export function isSampleApp(name: string): boolean {
  return name === DEFAULT_APP;
}

/**
 * The files a game adds beside the runtime, relative to its folder, in order:
 * the game host and its `package.json` in `resources/app`, and the web game in
 * `resources/game`.
 */
export function gameAppFiles(
  input: Pick<DesktopGamePackageInput, "host" | "game" | "name" | "version" | "gameId">,
  names: Pick<DesktopGameNames, "executable"> & {
    /** Linux: the installed `.desktop` file, which Electron names as the window's application ID. */
    desktopName?: string;
  },
): [string, Uint8Array][] {
  const encoder = new TextEncoder();
  const files: [string, Uint8Array][] = [
    ["resources/app/package.json", encoder.encode(`${JSON.stringify({
      name: names.executable.replace(/\.exe$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game",
      productName: input.name.trim() || "Game",
      version: input.version,
      main: "main.cjs",
      hapticGameId: input.gameId,
      ...(names.desktopName ? { desktopName: names.desktopName } : {}),
    }, null, 2)}\n`)],
    ["resources/app/main.cjs", input.host],
  ];
  for (const [path, data] of [...input.game].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`Invalid game file path: ${path}`);
    }
    files.push([`resources/game/${path}`, data]);
  }
  return files;
}

/**
 * A ZIP that runs the web game in Electron: the runtime's files unchanged
 * (renamed executable, Electron's sample app left out), the game host in
 * `resources/app/` and the game in `resources/game/`, all under one folder.
 * `rewriteExecutable` replaces the executable's bytes (`packageWindowsGame`
 * brands it); every other runtime file is copied without recompressing.
 */
export function packageDesktopGame(
  input: DesktopGamePackageInput,
  rewriteExecutable?: (executable: Uint8Array) => Uint8Array,
): { fileName: string; bytes: Uint8Array } {
  const names = desktopGameNames(input.name, input.target);
  const runtime = readZipEntries(input.runtime);
  const executable = runtimeExecutable(input.target, runtime);
  const added: Zippable = {};
  if (rewriteExecutable) {
    const original = runtime.find((entry) => entry.name === executable)!;
    // The release's host system and attributes (a Unix mode included) stay with the new bytes.
    added[`${names.folder}/${names.executable}`] = [rewriteExecutable(readZipEntryData(input.runtime, original)),
      { os: original.madeBy >> 8, attrs: original.externalAttributes }];
  }
  for (const [path, data] of gameAppFiles(input, names)) added[`${names.folder}/${path}`] = data;
  const extra = zipSync(added, { level: 6, mtime: SAFE_ZIP_MTIME });
  const copies: ZipCopy[] = [
    ...runtime.filter((entry) => !isSampleApp(entry.name) && !(rewriteExecutable && entry.name === executable)).map((entry) => ({
      name: `${names.folder}/${entry.name === executable ? names.executable : entry.name}`,
      source: input.runtime,
      entry,
    })),
    ...readZipEntries(extra).map((entry) => ({ name: entry.name, source: extra, entry })),
  ];
  return { fileName: names.archive, bytes: writeZip(copies) };
}
