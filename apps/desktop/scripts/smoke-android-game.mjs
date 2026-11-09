// With a JDK and the Android SDK (the Ubuntu runner's): packages a small game
// from the Android template exactly as the desktop app does, as an APK signed
// with a new keystore and as an App Bundle signed with Android's debug key,
// then checks both with the SDK's and the JDK's own tools.
//
// node apps/desktop/scripts/smoke-android-game.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { build } from "esbuild";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "haptic-android-game-smoke-"));
const bundle = join(work, "package-android.cjs");
await build({
  absWorkingDir: desktop,
  stdin: {
    contents: 'export { packageAndroidGame, findAndroidToolchain } from "./src/android-game-package"; export { ANDROID_ICON_SIZES } from "../../packages/exporter/src/native-android";',
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
const { packageAndroidGame, findAndroidToolchain, ANDROID_ICON_SIZES } = createRequire(import.meta.url)(bundle);

const { toolchain, problems } = await findAndroidToolchain({ sdk: null, java: null });
if (!toolchain) throw new Error(`No Android toolchain: ${problems.join(" ")}`);
console.log(`Java ${toolchain.javaVersion} at ${toolchain.javaHome}; build tools ${toolchain.buildTools}`);

/** A solid square PNG: numeric test data, not artwork. */
function png(size) {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x += 1) row.set([32, 128, 224, 255], 1 + x * 4);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
}

const tool = (name) => join(toolchain.javaHome, "bin", process.platform === "win32" ? `${name}.exe` : name);
const keystore = join(work, "release.p12");
execFileSync(tool("keytool"), ["-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-storepass", "smoke-store-pass", "-alias", "smoke",
  "-keyalg", "RSA", "-keysize", "2048", "-validity", "365", "-dname", "CN=Haptic Smoke,O=Haptic,C=NO"]);

const page = "<!doctype html><title>Smoke Game</title><p>Smoke Game</p>";
const base = {
  game: [["index.html", new TextEncoder().encode(page)], ["assets/data-1.bin", new Uint8Array([1, 2, 3])]],
  name: "Smoke Game", appId: "com.example.smokegame", version: "1.2.0", buildNumber: 7,
};
const templateRoot = join(desktop, "android-game");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" });
const expectIn = (text, needle, what) => { if (!text.includes(needle)) throw new Error(`${what} lacks ${needle}:\n${text}`); };

let started = Date.now();
const apk = await packageAndroidGame({
  request: { ...base, format: "apk", icon: ANDROID_ICON_SIZES.map((size) => [size, png(size)]) },
  settings: { java: null, sdk: null, keystore, alias: "smoke" },
  templateRoot,
  passwords: async () => ({ store: "smoke-store-pass", key: "" }),
});
console.log(`APK built and signed in ${Math.round((Date.now() - started) / 1000)} s: ${apk.fileName}, ${apk.bytes.length} bytes`);
if (apk.fileName !== "Smoke_Game-Android.apk" || apk.debugSigned) throw new Error(`Unexpected APK: ${apk.fileName}, debug ${apk.debugSigned}`);
const apkPath = join(work, apk.fileName);
writeFileSync(apkPath, apk.bytes);
expectIn(run(tool("java"), ["-jar", join(toolchain.buildTools, "lib", "apksigner.jar"), "verify", "--print-certs", "--verbose", apkPath]), "CN=Haptic Smoke", "apksigner verify");
const aapt2 = join(toolchain.buildTools, process.platform === "win32" ? "aapt2.exe" : "aapt2");
const badging = run(aapt2, ["dump", "badging", apkPath]);
for (const needle of ["package: name='com.example.smokegame' versionCode='7' versionName='1.2.0'", "application-label:'Smoke Game'",
  "launchable-activity: name='com.haptic.game.GameActivity'", "targetSdkVersion:'36'", "uses-gl-es: '0x30000'", "application-icon-640:'res/"]) {
  expectIn(badging, needle, "aapt2 dump badging");
}
// Release builds shorten resource file names, so the icons are checked by resource name.
const resources = run(aapt2, ["dump", "resources", apkPath]);
for (const name of [/mipmap\/ic_launcher(?!_)/, /mipmap\/ic_launcher_image/, /xxxhdpi/]) {
  if (!name.test(resources)) throw new Error(`aapt2 dump resources lacks ${name}:\n${resources}`);
}
// Two launcher images at five densities.
if ((resources.match(/type=PNG/g) ?? []).length < 10) throw new Error(`The APK lacks its launcher icons:\n${resources}`);
const apkFiles = run("unzip", ["-l", apkPath]);
for (const entry of ["assets/game/index.html", "assets/game/assets/data-1.bin", "classes.dex"]) expectIn(apkFiles, entry, "APK listing");

started = Date.now();
const aab = await packageAndroidGame({
  request: { ...base, format: "aab", icon: null },
  settings: { java: null, sdk: null, keystore: null, alias: "" },
  templateRoot,
  passwords: async () => { throw new Error("The debug key needs no passwords."); },
});
console.log(`App Bundle built and signed in ${Math.round((Date.now() - started) / 1000)} s: ${aab.fileName}, ${aab.bytes.length} bytes`);
if (aab.fileName !== "Smoke_Game-Android.aab" || !aab.debugSigned) throw new Error(`Unexpected App Bundle: ${aab.fileName}, debug ${aab.debugSigned}`);
const aabPath = join(work, aab.fileName);
writeFileSync(aabPath, aab.bytes);
const verified = run(tool("jarsigner"), ["-verify", "-verbose", "-certs", aabPath]);
expectIn(verified, "jar verified", "jarsigner -verify");
expectIn(verified, "CN=Android Debug", "jarsigner -verify");
const aabFiles = run("unzip", ["-l", aabPath]);
for (const entry of ["base/manifest/AndroidManifest.xml", "base/assets/game/index.html", "base/dex/classes.dex", "BundleConfig.pb"]) {
  expectIn(aabFiles, entry, "App Bundle listing");
}
console.log("Android game smoke passed: APK and App Bundle built, signed and verified.");
