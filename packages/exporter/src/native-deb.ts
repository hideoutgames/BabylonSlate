import { Gzip, gzipSync } from "fflate";
import {
  desktopGameNames, gameAppFiles, isSampleApp, runtimeExecutable,
  type DesktopGamePackageInput,
} from "./native-desktop";
import { readZipEntries, readZipEntryData, type ZipEntry } from "./zip-merge";

/**
 * A Debian package of a Linux game: the same folder as the Linux ZIP,
 * installed at `/opt/<command>/`, with a `/usr/bin/<command>` link and a menu
 * entry. dpkg installs `chrome-sandbox` owned by root with the setuid bit, so
 * Chromium's sandbox works on systems that refuse unprivileged user
 * namespaces (Ubuntu 23.10 and later), which a ZIP unpacked by a player can
 * never set up.
 */

/** `ustar` with GNU long names, which dpkg reads; paths start with `./`. */
interface TarEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  data?: Uint8Array;
  target?: string;
}

const encoder = new TextEncoder();
const BLOCK = 512;
/** 1980-01-01, as the ZIPs store it; packages are reproducible. */
const MTIME = 315532800;
const SETUID_SANDBOX_MODE = 0o4755;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function tarHeader(name: string, entry: TarEntry, size: number, type: string): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const put = (text: string, offset: number, length: number) => header.set(encoder.encode(text).subarray(0, length), offset);
  put(name, 0, 100);
  put(octal(entry.mode & 0o7777, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(MTIME, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  if (entry.target) put(entry.target, 157, 100);
  put("ustar  \0", 257, 8);
  put("root", 265, 32);
  put("root", 297, 32);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** One entry's blocks: a GNU long name record first when the path needs it. */
function tarBlocks(entry: TarEntry): Uint8Array[] {
  const name = entry.type === "directory" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  const blocks: Uint8Array[] = [];
  const nameBytes = encoder.encode(name);
  if (nameBytes.length >= 100) {
    const long = new Uint8Array(nameBytes.length + 1);
    long.set(nameBytes);
    blocks.push(tarHeader("././@LongLink", { ...entry, mode: 0o644 }, long.length, "L"), long, padding(long.length));
  }
  if (entry.target && encoder.encode(entry.target).length >= 100) throw new Error(`Link target too long: ${entry.target}`);
  const data = entry.type === "file" ? entry.data ?? new Uint8Array() : new Uint8Array();
  blocks.push(tarHeader(name, entry, data.length, entry.type === "file" ? "0" : entry.type === "directory" ? "5" : "2"));
  if (data.length > 0) blocks.push(data, padding(data.length));
  return blocks;
}

function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

/** Every parent folder of `paths`, parents first, as `./a`, `./a/b`. */
function directories(paths: readonly string[]): string[] {
  const seen = new Set<string>(["."]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 2; index < parts.length; index += 1) seen.add(parts.slice(0, index).join("/"));
  }
  return [...seen].sort();
}

/** An `ar` archive, as `.deb` packages are. */
function arArchive(members: readonly [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode("!<arch>\n")];
  for (const [name, data] of members) {
    const field = (text: string, length: number) => text.padEnd(length, " ");
    parts.push(encoder.encode(`${field(name, 16)}${field(String(MTIME), 12)}${field("0", 6)}${field("0", 6)}${field("100644", 8)}${field(String(data.length), 10)}\`\n`));
    parts.push(data);
    if (data.length % 2 === 1) parts.push(encoder.encode("\n"));
  }
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A Debian version: the project's, when it is one; `0` otherwise. */
export function debianVersion(version: string): string {
  const trimmed = version.trim();
  return /^[0-9][A-Za-z0-9.+~-]*$/.test(trimmed) && !trimmed.endsWith("-") ? trimmed : "0";
}

/** Debian package name: the game's command, at least two characters. */
export function debianPackageName(command: string): string {
  return command.length >= 2 ? command : `${command}-game`;
}

/** A `.desktop` value with the characters its format escapes. */
function desktopValue(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/**
 * The game as a `.deb` for 64-bit Debian and Ubuntu (`amd64`), named like the
 * ZIP (`Space_Game-Linux.deb`).
 */
export function packageLinuxDeb(input: DesktopGamePackageInput): { fileName: string; bytes: Uint8Array } {
  if (input.target !== "linux-x64") throw new Error("Debian packages hold Linux games only.");
  const names = desktopGameNames(input.name, input.target);
  const command = names.executable;
  const packageName = debianPackageName(command);
  const root = `./opt/${packageName}`;
  const runtime = readZipEntries(input.runtime);
  const executable = runtimeExecutable(input.target, runtime);
  const title = input.name.trim() || "Game";

  // A runtime file's bytes are read from `source` only when it is written.
  const files: (TarEntry & { source?: ZipEntry })[] = [];
  for (const entry of runtime) {
    if (isSampleApp(entry.name) || entry.name.endsWith("/")) continue;
    const name = entry.name === executable ? command : entry.name;
    // The release records Unix modes; the sandbox helper must also be setuid root.
    const unixMode = entry.madeBy >> 8 === 3 ? (entry.externalAttributes >>> 16) & 0o777 : 0o644;
    const mode = name === "chrome-sandbox" ? SETUID_SANDBOX_MODE : unixMode || 0o644;
    files.push({ path: `${root}/${name}`, type: "file", mode, source: entry });
  }
  for (const [path, data] of gameAppFiles(input, names)) files.push({ path: `${root}/${path}`, type: "file", mode: 0o644, data });
  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${desktopValue(title)}`,
    `Exec=/opt/${packageName}/${command} %U`,
    "Terminal=false",
    "Categories=Game;",
    "",
  ].join("\n");
  files.push({ path: `./usr/share/applications/${packageName}.desktop`, type: "file", mode: 0o644, data: encoder.encode(desktopEntry) });
  const link: TarEntry = { path: `./usr/bin/${command}`, type: "symlink", mode: 0o777, target: `/opt/${packageName}/${command}` };

  // data.tar.gz is written as it is read: one runtime file inflated at a time.
  const gzipped: Uint8Array[] = [];
  const gzip = new Gzip({ level: 6, mtime: 0 }, (chunk) => { gzipped.push(chunk); });
  let installedBytes = 0;
  for (const path of directories([...files.map((file) => file.path), link.path])) {
    for (const block of tarBlocks({ path, type: "directory", mode: 0o755 })) gzip.push(block);
  }
  for (const file of files) {
    const data = file.source ? readZipEntryData(input.runtime, file.source) : file.data!;
    installedBytes += data.length;
    for (const block of tarBlocks({ path: file.path, type: "file", mode: file.mode, data })) gzip.push(block);
  }
  for (const block of tarBlocks(link)) gzip.push(block);
  gzip.push(tarEnd(), true);
  const data = concat(gzipped);

  const control = [
    `Package: ${packageName}`,
    `Version: ${debianVersion(input.version)}`,
    "Architecture: amd64",
    `Maintainer: ${title.replace(/[\r\n]/g, " ")}`,
    `Installed-Size: ${Math.ceil(installedBytes / 1024)}`,
    "Section: games",
    "Priority: optional",
    `Description: ${title.replace(/[\r\n]/g, " ")}`,
    " A game made with Haptic.",
    "",
  ].join("\n");
  // dpkg keeps the archive's setuid bit; the script repeats it in case a policy stripped it.
  const postinst = `#!/bin/sh\nset -e\nchmod 4755 '/opt/${packageName}/chrome-sandbox' || true\n`;
  const controlTar = gzipSync(concat([
    ...tarBlocks({ path: "./", type: "directory", mode: 0o755 }),
    ...tarBlocks({ path: "./control", type: "file", mode: 0o644, data: encoder.encode(control) }),
    ...tarBlocks({ path: "./postinst", type: "file", mode: 0o755, data: encoder.encode(postinst) }),
    tarEnd(),
  ]), { level: 9, mtime: 0 });

  return {
    fileName: names.archive.replace(/\.zip$/, ".deb"),
    bytes: arArchive([["debian-binary", encoder.encode("2.0\n")], ["control.tar.gz", controlTar], ["data.tar.gz", data]]),
  };
}
