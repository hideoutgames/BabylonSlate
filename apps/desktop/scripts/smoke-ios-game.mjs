// On a Mac with Xcode (the macOS runner's): writes an iOS game's Xcode project
// from the template exactly as the desktop app does, builds it for devices
// without signing (a runner has no Apple account), and checks the app's
// identity, icon and game files. Signing and export need the user's account,
// so this checks everything up to them.
//
// node apps/desktop/scripts/smoke-ios-game.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.platform !== "darwin") throw new Error("The iOS game smoke runs on a Mac.");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "haptic-ios-game-smoke-"));
const bundle = join(work, "package-ios.cjs");
await build({
  absWorkingDir: desktop,
  stdin: {
    contents: 'export { writeIosProject, findXcode } from "./src/ios-game-package"; export { encodeOpaquePng } from "../../packages/exporter/src/app-icon"; export { buildSettingArguments } from "../../packages/exporter/src/native-ios";',
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
const { writeIosProject, findXcode, encodeOpaquePng, buildSettingArguments } = createRequire(import.meta.url)(bundle);

const xcode = await findXcode();
if (xcode.problems.length > 0) throw new Error(`Xcode is not ready: ${xcode.problems.join(" ")}`);
console.log(`Xcode ${xcode.version}`);

// A half-transparent solid square: numeric test data, not artwork.
const rgba = new Uint8Array(1024 * 1024 * 4);
for (let pixel = 0; pixel < rgba.length; pixel += 4) rgba.set([32, 128, 224, 128], pixel);
const project = join(work, "project");
const settings = await writeIosProject(project, {
  game: [["index.html", new TextEncoder().encode("<!doctype html><title>Smoke Game</title>")], ["assets/data-1.bin", new Uint8Array([1, 2, 3])]],
  name: "Smoke Game", appId: "com.example.smokegame", version: "1.2.0", buildNumber: 7, format: "app-store",
  icon: encodeOpaquePng(1024, 1024, rgba), teamId: "ABCDE12345",
}, join(desktop, "ios-game"));

const derived = join(work, "derived");
const started = Date.now();
execFileSync("/usr/bin/xcodebuild", [
  "-project", join(project, "HapticGame.xcodeproj"), "-scheme", "HapticGame", "-configuration", "Release",
  "-destination", "generic/platform=iOS", "-derivedDataPath", derived, "build", "CODE_SIGNING_ALLOWED=NO",
  // The runner has no account for a team: build unsigned with everything else as packaging passes it.
  ...buildSettingArguments(Object.fromEntries(Object.entries(settings).filter(([name]) => name !== "DEVELOPMENT_TEAM"))),
], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`Built in ${Math.round((Date.now() - started) / 1000)} s.`);

const app = join(derived, "Build", "Products", "Release-iphoneos", "HapticGame.app");
const plist = join(app, "Info.plist");
const read = (key) => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", plist]).toString().trim();
for (const [key, expected] of [
  ["CFBundleIdentifier", "com.example.smokegame"], ["CFBundleDisplayName", "Smoke Game"], ["CFBundleShortVersionString", "1.2.0"],
  ["CFBundleVersion", "7"], ["CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName", "AppIcon"], ["UIStatusBarHidden", "true"],
]) {
  const value = read(key);
  if (value !== expected) throw new Error(`${key} is ${value}, not ${expected}`);
}
for (const file of ["game/index.html", "game/assets/data-1.bin", "Assets.car", "HapticGame"]) {
  if (!existsSync(join(app, file))) throw new Error(`The app lacks ${file}`);
}
const alpha = execFileSync("/usr/bin/sips", ["-g", "hasAlpha", join(project, "HapticGame", "Assets.xcassets", "AppIcon.appiconset", "AppIcon.png")]).toString();
if (!/hasAlpha: no/.test(alpha)) throw new Error(`The App Store icon has an alpha channel:\n${alpha}`);
console.log("iOS game smoke passed: the app built unsigned with its identity, icon and game.");
