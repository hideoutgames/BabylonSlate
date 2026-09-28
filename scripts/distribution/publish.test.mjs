import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { artifactNames, createIdentity } from "./contract.mjs";
import { publishRelease } from "./publish.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha512 = bytes => createHash("sha512").update(bytes).digest("base64");
const identityFor = (patch = {}) => createIdentity({ version: "0.0.1", declaredVersion: "0.0.1", channel: "test", platforms: "windows", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1, ...patch });

function packageFiles(platform, identity, toolchains = { node: "22.23.2", pnpm: "10.33.3" }, extra = {}) {
  const manifest = { ...identity, toolchains, platform, ...(platform === "macos" ? { macosSigned: extra.macosSigned === true } : {}) };
  const files = new Map(artifactNames(platform, identity.packageVersion).map(name => [name, Buffer.from(`${platform}:${name}`)]));
  if (identity.channel === "release" && ["windows", "macos", "linux"].includes(platform)) {
    const feedName = { windows: "latest.yml", macos: "latest-mac.yml", linux: "latest-linux.yml" }[platform];
    const required = platform === "windows"
      ? [`BabylonSlate-${identity.packageVersion}-x64.exe`]
      : platform === "macos"
        ? ["arm64", "x64"].map(arch => `BabylonSlate-${identity.packageVersion}-${arch}.zip`)
        : [`BabylonSlate-${identity.packageVersion}-x64.AppImage`];
    const entries = required.map(name => ({ url: name, sha512: sha512(files.get(name)), size: files.get(name).length }));
    files.set(feedName, Buffer.from(JSON.stringify({ version: identity.packageVersion, files: entries, path: entries[0].url, sha512: entries[0].sha512 })));
  }
  files.set("build-manifest.json", Buffer.from(JSON.stringify(manifest)));
  files.set("SHA256SUMS.txt", Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join("")));
  return files;
}

function fixture(identity) {
  let release = null;
  let tagSha = null;
  const requests = [];
  const api = async (path, options = {}) => {
    requests.push({ path, ...options });
    if (path.startsWith("/git/ref/tags/")) return tagSha ? { object: { type: "commit", sha: tagSha } } : null;
    if (path.startsWith("/releases/tags/")) return release;
    if (path === "/releases" && options.method === "POST") {
      release = { ...options.body, id: 42, assets: [], upload_url: "https://uploads.github.com/repos/owner/repo/releases/42/assets{?name,label}" };
      tagSha = identity.sourceSha;
      return release;
    }
    if (path.startsWith("https://uploads.github.com/")) {
      const asset = { id: release.assets.length + 1, name: new URL(path).searchParams.get("name"), size: options.bytes.length, digest: `sha256:${hash(options.bytes)}`, state: "uploaded" };
      release.assets.push(asset);
      return asset;
    }
    if (path === "/releases/42" && options.method === "PATCH") { release = { ...release, ...options.body }; return release; }
    if (path === "/releases/42") return release;
    throw new Error(`Unexpected endpoint: ${path}`);
  };
  return { api, requests, current: () => release };
}

test("publication stages a draft, merges metadata and publishes an indev prerelease", async () => {
  const identity = identityFor();
  const client = fixture(identity);
  await publishRelease({ identity, platformFiles: new Map([["windows", packageFiles("windows", identity)]]), appleState: "available" }, client.api);
  const release = client.current();
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, "false");
  assert.equal(release.target_commitish, identity.sourceSha);
  assert.equal(release.assets.length, 3);
  assert.equal(client.requests.find(item => item.path === "/releases").body.draft, true);
  assert.match(release.body, /Unsigned x64 NSIS/);
  assert.match(release.body, /Android versionCode: 417001/);
});

test("every requested package is required before publication", async () => {
  const identity = identityFor({ platforms: "desktop" });
  await assert.rejects(publishRelease({ identity, platformFiles: new Map([["windows", packageFiles("windows", identity)]]) }, fixture(identity).api), /Every requested platform package/);
});

test("checksum and manifest identity disagreements block all publication writes", async () => {
  const identity = identityFor();
  const corrupt = packageFiles("windows", identity);
  corrupt.set(`BabylonSlate-${identity.packageVersion}-x64.exe`, Buffer.from("changed"));
  const checksumClient = fixture(identity);
  await assert.rejects(publishRelease({ identity, platformFiles: new Map([["windows", corrupt]]) }, checksumClient.api), /checksum/i);
  assert.equal(checksumClient.requests.filter(item => item.method).length, 0);
  const wrongIdentity = packageFiles("windows", identity);
  const manifest = JSON.parse(wrongIdentity.get("build-manifest.json"));
  manifest.sourceSha = "b".repeat(40);
  wrongIdentity.set("build-manifest.json", Buffer.from(JSON.stringify(manifest)));
  wrongIdentity.set("SHA256SUMS.txt", Buffer.from([...wrongIdentity].filter(([name]) => name !== "SHA256SUMS.txt").map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join("")));
  await assert.rejects(publishRelease({ identity, platformFiles: new Map([["windows", wrongIdentity]]) }, fixture(identity).api), /manifest identity differs/);
});

test("multiple platforms merge toolchains, checksums and macOS signing state", async () => {
  const identity = identityFor({ platforms: "desktop" });
  const platformFiles = new Map([
    ["windows", packageFiles("windows", identity, { node: "22.23.2", pnpm: "10.33.3", electron: "44.2.0" })],
    ["macos", packageFiles("macos", identity, { node: "22.23.2", pnpm: "10.33.3", electron: "44.2.0" }, { macosSigned: true })],
    ["linux", packageFiles("linux", identity, { node: "22.23.2", pnpm: "10.33.3", electron: "44.2.0" })],
  ]);
  const client = fixture(identity);
  await publishRelease({ identity, platformFiles }, client.api);
  const manifestUpload = client.requests.find(item => item.path.startsWith("https://uploads.github.com/") && new URL(item.path).searchParams.get("name") === "build-manifest.json");
  const merged = JSON.parse(manifestUpload.bytes);
  assert.deepEqual(merged.platformsBuilt, ["linux", "macos", "windows"]);
  assert.equal(merged.macosSigned, true);
  assert.deepEqual(merged.toolchains, { node: "22.23.2", pnpm: "10.33.3", electron: "44.2.0" });
  assert.match(client.current().body, /signed and notarized/);
});

test("conflicting toolchain values fail before publication", async () => {
  const identity = identityFor({ platforms: "desktop" });
  const platformFiles = new Map([
    ["windows", packageFiles("windows", identity, { node: "22.23.2" })],
    ["macos", packageFiles("macos", identity, { node: "23.0.0" })],
    ["linux", packageFiles("linux", identity, { node: "22.23.2" })],
  ]);
  await assert.rejects(publishRelease({ identity, platformFiles }, fixture(identity).api), /Conflicting toolchain/);
});

test("release publication validates patch notes, updater feed and Apple gate", async () => {
  const identity = { ...identityFor({ version: "0.0.2", declaredVersion: "0.0.2", channel: "release", runNumber: 418 }), patchNotes: { version: "0.0.2", title: "Editor Improvements", changes: ["Projects reopen faster."] } };
  const client = fixture(identity);
  await publishRelease({ identity, platformFiles: new Map([["windows", packageFiles("windows", identity)]]) }, client.api);
  assert.match(client.current().body, /## Editor Improvements\n\n- Projects reopen faster\./);
  assert.equal(client.current().prerelease, false);
  assert.ok(client.current().assets.some(asset => asset.name === "latest.yml"));
  const missingFeed = packageFiles("windows", identity);
  missingFeed.delete("latest.yml");
  await assert.rejects(publishRelease({ identity, platformFiles: new Map([["windows", missingFeed]]) }, fixture(identity).api), /allowlist/);
  const mobile = { ...identityFor({ version: "0.0.2", declaredVersion: "0.0.2", channel: "release", runNumber: 418, platforms: "mobile" }), patchNotes: identity.patchNotes };
  await assert.rejects(publishRelease({ identity: mobile, platformFiles: new Map([["android", packageFiles("android", mobile)]]), appleState: "failed" }, fixture(mobile).api), /Apple/);
});

test("a published release cannot be overwritten on retry", async () => {
  const identity = identityFor();
  const platformFiles = new Map([["windows", packageFiles("windows", identity)]]);
  const client = fixture(identity);
  await publishRelease({ identity, platformFiles }, client.api);
  await assert.rejects(publishRelease({ identity, platformFiles }, client.api), /immutable/);
});
