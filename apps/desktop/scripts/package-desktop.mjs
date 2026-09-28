import { listPackage } from "@electron/asar";
import { build, Platform, Arch } from "electron-builder";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stageRenderer } from "./layout.mjs";
import { artifactNames, platformArtifactNames, validateArtifacts } from "../../../scripts/distribution/contract.mjs";
import { validatePatchNotes } from "../../../scripts/distribution/changelog.mjs";
import { validateUpdateFeed } from "../../../scripts/distribution/update-feed.mjs";

const platform = process.argv[2];
const hosts = { windows: "win32", macos: "darwin", linux: "linux" };
if (!hosts[platform] || process.platform !== hosts[platform]) throw new Error(`${platform || "Desktop"} packaging requires its native host`);
if (process.env.VITE_TEST_MODE === "true" || process.env.VITE_TEST_QUERY === "true") throw new Error("Native distribution must use production storage");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(desktop, "../editor/dist/build-manifest.json"), "utf8"));
if (!["test", "release"].includes(manifest.channel) || !manifest.packageVersion || manifest.platform !== platform) throw new Error("Distribution manifest required for the selected platform");
if (manifest.channel === "release") validatePatchNotes(manifest.patchNotes, manifest.applicationVersion);
const stage = join(desktop, "dist/app");
try { await access(stage); throw new Error("Packaging stage already exists; use a clean checkout"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(stage, { recursive: true });
await cp(join(desktop, "dist/host"), join(stage, "host"), { recursive: true });
await stageRenderer(join(desktop, "../editor/dist"), join(stage, "renderer"));
await writeFile(join(stage, "package.json"), JSON.stringify({ name: "babylonslate", productName: "BabylonSlate", desktopName: "babylonslate.desktop", version: manifest.packageVersion, main: "host/main.cjs", description: "BabylonSlate editor", author: "Hideout Games" }, null, 2));

const targets = {
  windows: () => Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  macos: () => Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64, Arch.x64),
  linux: () => Platform.LINUX.createTarget(["AppImage"], Arch.x64),
};
const output = join(desktop, "dist/installers");
async function findAppArchives(directory) {
  const archives = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) archives.push(...await findAppArchives(path));
    else if (entry.isFile() && entry.name === "app.asar") archives.push(path);
  }
  return archives;
}
async function validateAppArchives() {
  const archives = await findAppArchives(output);
  if (archives.length === 0) throw new Error("Packaged app.asar was not produced");
  const allowed = new Set(["package.json", "host", "renderer"]);
  const unexpected = new Set();
  for (const archive of archives) {
    for (const name of listPackage(archive)) {
      const root = name.replaceAll("\\", "/").replace(/^\//, "").split("/")[0];
      if (root && !allowed.has(root)) unexpected.add(root);
    }
  }
  if (unexpected.size) throw new Error(`Packaged app.asar contains unexpected roots: ${[...unexpected].sort().join(", ")}`);
}
const signingEnvironment = ["APPLE_DEVELOPER_ID_P12_BASE64", "APPLE_DEVELOPER_ID_PASSWORD", "ASC_PRIVATE_KEY_P8_BASE64", "ASC_KEY_ID", "ASC_ISSUER_ID", "CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"];
let privateKeyDirectory;
try {
  const config = { extends: join(desktop, "electron-builder.yml"), ...(manifest.channel === "test" ? { publish: null } : {}) };
  if (platform === "macos" && manifest.macosSigned === true) {
    const required = ["APPLE_DEVELOPER_ID_P12_BASE64", "APPLE_DEVELOPER_ID_PASSWORD", "ASC_PRIVATE_KEY_P8_BASE64", "ASC_KEY_ID", "ASC_ISSUER_ID", "APPLE_TEAM_ID"];
    for (const name of required) if (!process.env[name]) throw new Error(`Missing required macOS signing variable: ${name}`);
    privateKeyDirectory = await mkdtemp(join(tmpdir(), "babylonslate-notarization-"));
    const privateKeyPath = join(privateKeyDirectory, "AuthKey.p8");
    await writeFile(privateKeyPath, Buffer.from(process.env.ASC_PRIVATE_KEY_P8_BASE64, "base64"), { mode: 0o600 });
    process.env.CSC_LINK = process.env.APPLE_DEVELOPER_ID_P12_BASE64;
    process.env.CSC_KEY_PASSWORD = process.env.APPLE_DEVELOPER_ID_PASSWORD;
    process.env.APPLE_API_KEY = privateKeyPath;
    process.env.APPLE_API_KEY_ID = process.env.ASC_KEY_ID;
    process.env.APPLE_API_ISSUER = process.env.ASC_ISSUER_ID;
    config.mac = { notarize: true };
  } else {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    if (platform === "macos") config.mac = { notarize: false };
  }
  await build({ projectDir: desktop, targets: targets[platform](), publish: "never", config });
  await validateAppArchives();
} finally {
  if (privateKeyDirectory) await rm(privateKeyDirectory, { recursive: true, force: true });
  for (const name of [...signingEnvironment, "CSC_IDENTITY_AUTO_DISCOVERY"]) delete process.env[name];
}

const publicDir = join(desktop, "dist/public");
await mkdir(publicDir, { recursive: true });
const assets = new Map();
for (const name of artifactNames(platform, manifest.packageVersion)) {
  const bytes = await readFile(join(output, name));
  assets.set(name, bytes);
  await writeFile(join(publicDir, name), bytes);
}
if (manifest.channel === "release") validateUpdateFeed(platform, manifest.packageVersion, assets);
await writeFile(join(publicDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
assets.set("build-manifest.json", await readFile(join(publicDir, "build-manifest.json")));
await writeFile(join(publicDir, "SHA256SUMS.txt"), [...assets]
  .map(([name, contents]) => `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`)
  .sort()
  .join(""));
validateArtifacts(platformArtifactNames(platform, manifest.packageVersion), await readdir(publicDir));
console.log((await readdir(output)).sort().join("\n"));
