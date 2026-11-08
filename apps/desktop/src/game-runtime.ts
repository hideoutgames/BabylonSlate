import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRaw as deflateRawCallback } from "node:zlib";

const deflateRaw = promisify(deflateRawCallback);

/** The executable's name in Electron's official release zip for each desktop platform. */
const RELEASE_EXECUTABLE: Partial<Record<NodeJS.Platform, string>> = { win32: "electron.exe", linux: "electron" };

/** At most this many runtime files, as a release lists them (Electron's have under a hundred). */
export const MAX_RUNTIME_FILES = 1000;

/** A release-relative file name: forward slashes, no parent or absolute parts. */
export function isRuntimeFileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !name.includes("\\") && !name.includes(":") &&
    !name.includes("\0") && !isAbsolute(name) && name.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

interface RuntimeFile {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  size: number;
  mode: number;
}

/**
 * This app's own Electron runtime as a zip laid out like Electron's official
 * release for the platform: `files` are the release's names, read from the
 * install folder, with the running executable stored under the release's
 * executable name. The editor packages a game for its own OS from it instead
 * of carrying a second copy of the same runtime.
 */
export async function ownRuntimeZip(options: {
  installDir: string;
  executablePath: string;
  files: readonly string[];
  platform: NodeJS.Platform;
}): Promise<Uint8Array> {
  const releaseExecutable = RELEASE_EXECUTABLE[options.platform];
  if (!releaseExecutable) throw new Error(`This desktop app cannot package games for ${options.platform}.`);
  if (options.files.length > MAX_RUNTIME_FILES || !options.files.every(isRuntimeFileName)) throw new Error("Invalid runtime file list.");
  if (!options.files.includes(releaseExecutable)) throw new Error(`The runtime file list has no ${releaseExecutable}.`);
  const encoder = new TextEncoder();
  const unix = options.platform !== "win32";
  const files: RuntimeFile[] = [];
  for (const name of options.files) {
    // Electron's sample app is not installed beside the editor, and the game host replaces it.
    if (name === "resources/default_app.asar") continue;
    const path = name === releaseExecutable ? options.executablePath : join(options.installDir, normalize(name));
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      throw new Error(`This desktop app is missing a runtime file: ${name}. Reinstall Haptic.`);
    }
    if (!stat.isFile()) throw new Error(`Runtime file ${name} is not a regular file.`);
    const raw = new Uint8Array(await readFile(path));
    files.push({ name: encoder.encode(name), data: new Uint8Array(await deflateRaw(raw, { level: 6 })), crc: crc32(raw), size: raw.length, mode: unix ? stat.mode & 0o777 : 0 });
  }
  return writeDeflatedZip(files, unix);
}

/** DOS date and time of 1980-01-01 00:00, as Electron's releases store them. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function writeDeflatedZip(files: readonly RuntimeFile[], unix: boolean): Uint8Array {
  const localSize = files.reduce((total, file) => total + 30 + file.name.length + file.data.length, 0);
  const centralSize = files.reduce((total, file) => total + 46 + file.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff) throw new Error("The runtime is larger than a zip can hold.");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let offset = 0;
  for (const file of files) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x800, true);
    view.setUint16(offset + 8, 8, true);
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, file.crc, true);
    view.setUint32(offset + 18, file.data.length, true);
    view.setUint32(offset + 22, file.size, true);
    view.setUint16(offset + 26, file.name.length, true);
    out.set(file.name, offset + 30);
    out.set(file.data, offset + 30 + file.name.length);
    offset += 30 + file.name.length + file.data.length;
  }
  const directory = offset;
  files.forEach((file, index) => {
    view.setUint32(offset, 0x02014b50, true);
    // Unix (3) keeps each file's mode, so the game's executables stay runnable.
    view.setUint16(offset + 4, unix ? (3 << 8) | 20 : 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x800, true);
    view.setUint16(offset + 10, 8, true);
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.data.length, true);
    view.setUint32(offset + 24, file.size, true);
    view.setUint16(offset + 28, file.name.length, true);
    view.setUint32(offset + 38, unix ? ((0o100000 | file.mode) << 16) >>> 0 : 0, true);
    view.setUint32(offset + 42, offsets[index]!, true);
    out.set(file.name, offset + 46);
    offset += 46 + file.name.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - directory, true);
  view.setUint32(offset + 16, directory, true);
  return out;
}
