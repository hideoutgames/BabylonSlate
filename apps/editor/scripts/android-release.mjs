import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { platformArtifactNames, validateArtifacts } from "../../../scripts/distribution/contract.mjs";
import { validatePatchNotes } from "../../../scripts/distribution/changelog.mjs";

if (process.env.VITE_TEST_MODE === "true" || process.env.VITE_TEST_QUERY === "true") throw new Error("Native distribution must use production storage");
const editorDir = fileURLToPath(new URL("..", import.meta.url));
const androidDir = join(editorDir, "android");
const manifest = JSON.parse(await readFile(join(editorDir, "dist/build-manifest.json"), "utf8"));
if (!["test", "release"].includes(manifest.channel) || !manifest.packageVersion || manifest.platform !== "android" || !Number.isSafeInteger(manifest.androidVersionCode) || manifest.androidVersionCode < 1) {
  throw new Error("Android distribution manifest required");
}
if (manifest.channel === "release") validatePatchNotes(manifest.patchNotes, manifest.applicationVersion);
const required = ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"];
for (const name of required) if (!process.env[name]) throw new Error(`Android release signing is not provisioned: ${name}`);

const temporaryRoot = process.env.RUNNER_TEMP ?? tmpdir();
const keystore = join(temporaryRoot, `babylonslate-android-${randomBytes(12).toString("hex")}.jks`);
const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32" && command.endsWith(".bat"),
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${options.label ?? command} failed with status ${result.status}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

try {
  await writeFile(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64"), { mode: 0o600 });
  run(wrapper, [
    "assembleRelease",
    "--no-daemon",
    `-PbabylonslateVersionCode=${manifest.androidVersionCode}`,
    `-PbabylonslateVersionName=${manifest.packageVersion}`,
  ], {
    cwd: androidDir,
    label: "Android release build",
    env: {
      ...process.env,
      BABYLONSLATE_ANDROID_KEYSTORE: keystore,
      BABYLONSLATE_ANDROID_KEYSTORE_PASSWORD: process.env.ANDROID_KEYSTORE_PASSWORD,
      BABYLONSLATE_ANDROID_KEY_ALIAS: process.env.ANDROID_KEY_ALIAS,
      BABYLONSLATE_ANDROID_KEY_PASSWORD: process.env.ANDROID_KEY_PASSWORD,
    },
  });
} finally {
  await rm(keystore, { force: true });
}

const releaseDir = join(androidDir, "app/build/outputs/apk/release");
const apk = join(releaseDir, "app-release.apk");
try {
  await access(apk);
} catch {
  try {
    await access(join(releaseDir, "app-release-unsigned.apk"));
    throw new Error("Android release APK is unsigned");
  } catch (error) {
    if (error instanceof Error && error.message === "Android release APK is unsigned") throw error;
    throw new Error("Android release APK was not produced");
  }
}

const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdkRoot) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT is required to verify the APK");
const buildToolsRoot = join(sdkRoot, "build-tools");
const versions = (await readdir(buildToolsRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+){1,3}$/.test(entry.name))
  .map(entry => entry.name)
  .sort((left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] ?? 0) - (a[index] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
if (!versions[0]) throw new Error("Android SDK build-tools are required to verify the APK");
const tools = join(buildToolsRoot, versions[0]);
const apksigner = join(tools, process.platform === "win32" ? "apksigner.bat" : "apksigner");
const aapt2 = join(tools, process.platform === "win32" ? "aapt2.exe" : "aapt2");
const certificate = run(apksigner, ["verify", "--print-certs", apk], { capture: true, label: "apksigner verification" });
if (/CN=Android Debug/i.test(certificate)) throw new Error("Android release APK uses the debug certificate");
const badging = run(aapt2, ["dump", "badging", apk], { capture: true, label: "aapt2 package verification" });
const packageLine = badging.split(/\r?\n/).find(line => line.startsWith("package: ")) ?? "";
for (const expected of [
  "name='no.hideout.babylonslate'",
  `versionCode='${manifest.androidVersionCode}'`,
  `versionName='${manifest.packageVersion}'`,
]) if (!packageLine.includes(expected)) throw new Error("Android APK package identity differs from the build manifest");

const publicDir = join(androidDir, "dist/public");
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
const apkName = `BabylonSlate-${manifest.packageVersion}-android.apk`;
const apkBytes = await readFile(apk);
await writeFile(join(publicDir, apkName), apkBytes);
await writeFile(join(publicDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const files = new Map([
  [apkName, apkBytes],
  ["build-manifest.json", await readFile(join(publicDir, "build-manifest.json"))],
]);
await writeFile(join(publicDir, "SHA256SUMS.txt"), [...files]
  .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
  .sort()
  .join(""));
validateArtifacts(platformArtifactNames("android", manifest.packageVersion), await readdir(publicDir));
const certificateSummary = certificate.split(/\r?\n/).find(line => /certificate DN:/i.test(line)) ?? "Certificate verified";
console.log(`Android APK: ${(await stat(join(publicDir, apkName))).size} bytes`);
console.log(certificateSummary.trim());
