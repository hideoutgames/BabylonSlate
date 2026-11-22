import { Gzip, gzipSync } from "fflate";
import { isValidAppId } from "@haptic/core/app-identity";
import { appIconPng, LINUX_ICON_SIZES } from "./app-icon";
import {
  desktopGameNames, gameAppFiles, isSampleApp, runtimeExecutable,
  type DesktopGamePackageInput,
} from "./native-desktop";
import { readZipEntries, readZipEntryData, type ZipEntry } from "./zip-merge";

/**
 * A Debian package of a Linux game: the same folder as the Linux ZIP,
 * installed at `/opt/<package>/`, with a `/usr/bin/<package>` link and a menu
 * entry, where the package name is the game's App ID in lowercase, so two
 * games with the same title never share files. `chrome-sandbox` is not
 * setuid: Chromium sandboxes the game with unprivileged user namespaces.
 * Ubuntu 23.10 and later refuse those to programs AppArmor does not allow, so
 * the package carries an AppArmor profile granting the game `userns`, which
 * `postinst` installs and loads where the system's AppArmor can read it.
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
/** Not setuid: Chromium's user-namespace sandbox needs no root helper. */
const SANDBOX_MODE = 0o755;

/**
 * The libraries Electron's Linux `electron` executable links (its ELF
 * `NEEDED` entries, from the release `build-game-shells.mjs` pins), by the
 * Debian and Ubuntu packages that ship them. Each library renamed in the
 * 64-bit `time_t` transition (Ubuntu 24.04, Debian 13) is listed with its
 * `t64` name as an alternative. Recheck when the Electron pin moves.
 */
export const DEBIAN_RUNTIME_DEPENDS: readonly string[] = [
  "libasound2 | libasound2t64",
  "libatk-bridge2.0-0 | libatk-bridge2.0-0t64",
  "libatk1.0-0 | libatk1.0-0t64",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libc6",
  "libcairo2",
  "libcups2 | libcups2t64",
  "libdbus-1-3",
  "libexpat1",
  "libgbm1",
  "libgcc-s1",
  "libglib2.0-0 | libglib2.0-0t64",
  "libgtk-3-0 | libgtk-3-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libudev1",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
];

/**
 * The control file's maintainer. Haptic has no publisher or contact setting,
 * so the address is a placeholder in the reserved `.invalid` domain, which
 * Debian's `Name <email>` form accepts and no mail can ever reach.
 */
export function debianMaintainer(title: string, packageName: string): string {
  const name = title.replace(/[<>,\r\n]/g, " ").replace(/\s+/g, " ").trim() || "Game";
  return `${name} <${packageName}@haptic-game.invalid>`;
}

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

/**
 * Debian package name: the App ID in lowercase (`com.studio.space-game` stays
 * unique where titles repeat). A valid App ID is letters and digits in
 * dot-separated segments that start with a letter, so its lowercase form is
 * always a valid Debian name: lowercase letters, digits and dots, starting
 * with a letter, at least three characters.
 */
export function debianPackageName(appId: string): string {
  if (!isValidAppId(appId)) throw new Error(`App ID ${appId} is not valid. Set it in Project Settings > Export.`);
  return appId.toLowerCase();
}

/** The AppArmor profile that lets the game's executable create user namespaces for Chromium's sandbox. */
function appArmorProfile(packageName: string, executablePath: string): string {
  return [
    `# Lets ${packageName} create user namespaces, which Chromium's sandbox needs, where AppArmor restricts them.`,
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${packageName} ${executablePath} flags=(unconfined) {`,
    "  userns,",
    "",
    "  # Site-specific additions and overrides. See local/README for details.",
    `  include if exists <local/${packageName}>`,
    "}",
    "",
  ].join("\n");
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
  const packageName = debianPackageName(input.appId);
  const root = `./opt/${packageName}`;
  const installedExecutable = `/opt/${packageName}/${command}`;
  const profileSource = `/opt/${packageName}/resources/apparmor-profile`;
  const profileTarget = `/etc/apparmor.d/${packageName}`;
  const runtime = readZipEntries(input.runtime);
  const executable = runtimeExecutable(input.target, runtime);
  const title = input.name.trim() || "Game";

  // A runtime file's bytes are read from `source` only when it is written.
  const files: (TarEntry & { source?: ZipEntry })[] = [];
  for (const entry of runtime) {
    if (isSampleApp(entry.name) || entry.name.endsWith("/")) continue;
    const name = entry.name === executable ? command : entry.name;
    // The release records Unix modes; the sandbox helper is an ordinary executable, never setuid.
    const unixMode = entry.madeBy >> 8 === 3 ? (entry.externalAttributes >>> 16) & 0o777 : 0o644;
    const mode = name === "chrome-sandbox" ? SANDBOX_MODE : unixMode || 0o644;
    files.push({ path: `${root}/${name}`, type: "file", mode, source: entry });
  }
  for (const [path, data] of gameAppFiles(input, { ...names, desktopName: `${packageName}.desktop` })) {
    files.push({ path: `${root}/${path}`, type: "file", mode: 0o644, data });
  }
  files.push({ path: `.${profileSource}`, type: "file", mode: 0o644, data: encoder.encode(appArmorProfile(packageName, installedExecutable)) });
  const icon = input.icon;
  if (icon) {
    for (const size of LINUX_ICON_SIZES) {
      files.push({ path: `./usr/share/icons/hicolor/${size}x${size}/apps/${packageName}.png`, type: "file", mode: 0o644, data: appIconPng(icon, size) });
    }
  }
  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${desktopValue(title)}`,
    `Exec=${installedExecutable} %U`,
    ...(icon ? [`Icon=${packageName}`] : []),
    // Electron's X11 window class is the product name; this ties the window to the entry.
    `StartupWMClass=${desktopValue(title)}`,
    "Terminal=false",
    "Categories=Game;",
    "",
  ].join("\n");
  files.push({ path: `./usr/share/applications/${packageName}.desktop`, type: "file", mode: 0o644, data: encoder.encode(desktopEntry) });
  const link: TarEntry = { path: `./usr/bin/${packageName}`, type: "symlink", mode: 0o777, target: installedExecutable };

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
    `Maintainer: ${debianMaintainer(title, packageName)}`,
    `Installed-Size: ${Math.ceil(installedBytes / 1024)}`,
    `Depends: ${DEBIAN_RUNTIME_DEPENDS.join(", ")}`,
    // The game host opens web links in the system browser with xdg-open.
    "Recommends: xdg-utils",
    "Section: games",
    "Priority: optional",
    `Description: ${title.replace(/[\r\n]/g, " ")}`,
    " A game made with Haptic.",
    "",
  ].join("\n");
  // The profile names `abi <abi/4.0>`, which AppArmor before 4 (Debian 12) cannot read; there unprivileged user
  // namespaces are not restricted and nothing is installed. A failure to load never fails the installation.
  const postinst = [
    "#!/bin/sh",
    "set -e",
    `PROFILE_SOURCE='${profileSource}'`,
    `PROFILE_TARGET='${profileTarget}'`,
    "if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then",
    "  if apparmor_parser --skip-kernel-load --debug \"$PROFILE_SOURCE\" >/dev/null 2>&1; then",
    "    cp -f \"$PROFILE_SOURCE\" \"$PROFILE_TARGET\"",
    "    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then",
    "      apparmor_parser --replace --write-cache --skip-read-cache \"$PROFILE_TARGET\" >/dev/null 2>&1 || true",
    "    fi",
    "  fi",
    "fi",
    "",
  ].join("\n");
  const postrm = [
    "#!/bin/sh",
    "set -e",
    `PROFILE_TARGET='${profileTarget}'`,
    "if [ \"$1\" = remove ] || [ \"$1\" = purge ]; then",
    "  if [ -f \"$PROFILE_TARGET\" ]; then",
    "    if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser --remove \"$PROFILE_TARGET\" >/dev/null 2>&1 || true; fi",
    "    rm -f \"$PROFILE_TARGET\"",
    "  fi",
    "fi",
    "",
  ].join("\n");
  const controlTar = gzipSync(concat([
    ...tarBlocks({ path: "./", type: "directory", mode: 0o755 }),
    ...tarBlocks({ path: "./control", type: "file", mode: 0o644, data: encoder.encode(control) }),
    ...tarBlocks({ path: "./postinst", type: "file", mode: 0o755, data: encoder.encode(postinst) }),
    ...tarBlocks({ path: "./postrm", type: "file", mode: 0o755, data: encoder.encode(postrm) }),
    tarEnd(),
  ]), { level: 9, mtime: 0 });

  return {
    fileName: names.archive.replace(/\.zip$/, ".deb"),
    bytes: arArchive([["debian-binary", encoder.encode("2.0\n")], ["control.tar.gz", controlTar], ["data.tar.gz", data]]),
  };
}
