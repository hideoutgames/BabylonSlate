// On a Mac: packages a small game from the editor build's bundled Apple
// Silicon player exactly as the desktop app does (ad-hoc signed), then checks
// the result with Apple's tools and launches it.
//
// node apps/desktop/scripts/smoke-mac-game.mjs <editor dist folder>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.platform !== "darwin") throw new Error("The macOS game smoke runs on a Mac.");
const dist = resolve(process.argv[2] ?? "");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "haptic-mac-game-smoke-"));
const bundle = join(work, "package-mac.cjs");
await build({
  absWorkingDir: desktop,
  stdin: {
    contents: 'export { packageMacGame } from "./src/mac-game-package"; export { readBundledShell } from "./src/game-runtime";',
    resolveDir: desktop,
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
});
const { packageMacGame, readBundledShell } = createRequire(import.meta.url)(bundle);

const shell = await readBundledShell(dist, "macos-arm64");
const page = "<!doctype html><title>Smoke Game</title><script>document.title = 'Smoke Game Running';</script>";
const result = await packageMacGame({
  request: {
    game: [["index.html", new TextEncoder().encode(page)]],
    name: "Smoke Game", appId: "com.example.smokegame", version: "1.0.0", buildNumber: 3,
    gameId: "smoke-game", identity: null, notaryProfile: "",
  },
  ...shell,
});
if (result.fileName !== "Smoke_Game-macOS.zip" || result.notarized) throw new Error(`Unexpected package: ${result.fileName}, notarized ${result.notarized}`);
const archive = join(work, result.fileName);
writeFileSync(archive, result.bytes);
const extracted = join(work, "extracted");
execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
const app = join(extracted, "Smoke Game.app");

execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
const plist = join(app, "Contents", "Info.plist");
const read = (key) => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", plist]).toString().trim();
for (const [key, expected] of [["CFBundleIdentifier", "com.example.smokegame"], ["CFBundleName", "Smoke Game"], ["CFBundleShortVersionString", "1.0.0"], ["CFBundleVersion", "3"]]) {
  if (read(key) !== expected) throw new Error(`${key} is ${read(key)}, not ${expected}`);
}
for (const file of ["Contents/Resources/app/main.cjs", "Contents/Resources/app/package.json", "Contents/Resources/game/index.html"]) {
  readFileSync(join(app, file));
}

// The game must still be running after a few seconds: a broken bundle or host exits at once.
const child = spawn(join(app, "Contents", "MacOS", "Electron"), [], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const exited = await new Promise((done) => {
  const timer = setTimeout(() => done(null), 10_000);
  child.on("exit", (code, signal) => { clearTimeout(timer); done({ code, signal }); });
});
if (exited) throw new Error(`The packaged game exited after launch (${JSON.stringify(exited)}):\n${output}`);
child.kill();
console.log(`macOS game smoke passed: ${result.fileName}, ${result.bytes.length} bytes, signature verified, launched.`);
