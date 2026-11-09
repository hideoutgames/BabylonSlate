// Assembles what an editor build carries for native game packaging, in --out:
// Electron's official runtime zips for the bundled targets, unchanged and
// split into parts GitHub Pages can serve; the game host; and manifest.json.
// Every runtime is checked against the SHA-256 the lockfile-pinned `electron`
// package records, so a build never carries a runtime Electron did not
// publish. `--own` targets are the desktop app's own OS: only their file
// list is recorded, and the app supplies its own runtime when packaging.
//
// node scripts/build-game-shells.mjs --out <dir> [--bundle windows-x64,linux-x64] [--own windows-x64]
// Without --bundle or --own, HAPTIC_GAME_SHELLS and HAPTIC_GAME_SHELL_OWN are read; with neither set it does nothing.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
/** Desktop targets as `<platform>-<arch>`, with Electron's names for them. */
export const SHELL_TARGETS = {
  "windows-x64": { platform: "win32", arch: "x64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  // Packaged only by the desktop app on a Mac, which signs it.
  "macos-arm64": { platform: "darwin", arch: "arm64" },
};
/** Each part stays well under the 100 MB a GitHub Pages file may have. */
export const PART_BYTES = 48 * 1024 * 1024;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : undefined;
}

function targets(value) {
  const list = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const target of list) if (!Object.hasOwn(SHELL_TARGETS, target)) throw new Error(`Unknown game shell target: ${target}`);
  return [...new Set(list)];
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** File names in a zip's central directory. */
export function zipFileNames(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("Not a zip archive.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Damaged zip central directory.");
    const nameLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return names.filter((name) => !name.endsWith("/"));
}

/** The official runtime zip for a target, from the cache or Electron's GitHub release, checked against `expected`. */
async function runtimeZip(version, target, expected) {
  const { platform, arch } = SHELL_TARGETS[target];
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  if (!expected) throw new Error(`electron/checksums.json has no checksum for ${name}.`);
  const cache = process.env.HAPTIC_ELECTRON_CACHE ?? join(homedir(), ".cache", "haptic-electron");
  const cached = join(cache, name);
  try {
    const bytes = new Uint8Array(await readFile(cached));
    if (sha256(bytes) === expected) return bytes;
  } catch { /* Not cached yet. */ }
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${version}/${name}`);
  if (!response.ok) throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${name} has SHA-256 ${actual}, not the ${expected} electron/checksums.json records.`);
  await mkdir(cache, { recursive: true });
  await writeFile(cached, bytes);
  return bytes;
}

async function main() {
  const out = option("--out");
  if (!out) throw new Error("--out is required.");
  const explicit = option("--bundle") !== undefined || option("--own") !== undefined;
  const bundle = targets(explicit ? option("--bundle") : process.env.HAPTIC_GAME_SHELLS);
  const own = targets(explicit ? option("--own") : process.env.HAPTIC_GAME_SHELL_OWN);
  if (bundle.length === 0 && own.length === 0) return;
  if (own.some((target) => bundle.includes(target))) throw new Error("A target is either bundled or the desktop app's own, not both.");
  const outDir = resolve(out);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = require("electron/package.json").version;
  const checksums = require("electron/checksums.json");
  const { build } = await import("esbuild");
  await build({
    absWorkingDir: desktop,
    entryPoints: ["src/game-host.ts"],
    outfile: join(outDir, "game-host.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false,
    logLevel: "warning",
  });
  const host = await readFile(join(outDir, "game-host.cjs"));

  const shells = [];
  for (const target of [...bundle, ...own]) {
    const { platform, arch } = SHELL_TARGETS[target];
    const expected = checksums[`electron-v${version}-${platform}-${arch}.zip`];
    const zip = await runtimeZip(version, target, expected);
    if (own.includes(target)) {
      shells.push({ target, sha256: expected, size: zip.length, source: "desktop", files: zipFileNames(zip) });
      continue;
    }
    const parts = [];
    for (let offset = 0, index = 0; offset < zip.length; offset += PART_BYTES, index += 1) {
      const file = `electron-${target}.zip.${String(index).padStart(3, "0")}`;
      await writeFile(join(outDir, file), zip.subarray(offset, offset + PART_BYTES));
      parts.push(file);
    }
    shells.push({ target, sha256: expected, size: zip.length, source: "bundled", parts });
  }
  const manifest = { electronVersion: version, host: { file: "game-host.cjs", sha256: sha256(host) }, shells };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Game shells: ${shells.map((shell) => `${shell.target} (${shell.source})`).join(", ")} for Electron ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
