import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createIdentity } from "./contract.mjs";
import { publishWindows } from "./publish.mjs";

const manifest = createIdentity({ version: "0.0.1", declaredVersion: "0.0.1", channel: "test", platforms: "both", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const installer = `BabylonSlate-${manifest.windowsVersion}-x64.exe`;
const files = new Map([[installer, Buffer.from("installer")], ["build-manifest.json", Buffer.from(JSON.stringify(manifest))]]);
files.set("SHA256SUMS.txt", Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join("")));

function fixture() {
  let release = null;
  let tagSha = null;
  const requests = [];
  const api = async (path, options = {}) => {
    requests.push({ path, ...options });
    if (path.startsWith("/git/ref/tags/")) return tagSha ? { object: { type: "commit", sha: tagSha } } : null;
    if (path.startsWith("/releases/tags/")) return release;
    if (path === "/releases" && options.method === "POST") { release = { ...options.body, id: 42, assets: [], upload_url: "https://uploads.github.com/repos/owner/repo/releases/42/assets{?name,label}" }; tagSha = manifest.sourceSha; return release; }
    if (path.startsWith("https://uploads.github.com/")) { const asset = { id: release.assets.length + 1, name: new URL(path).searchParams.get("name"), size: options.bytes.length, digest: `sha256:${hash(options.bytes)}`, state: "uploaded" }; release.assets.push(asset); return asset; }
    if (path === "/releases/42" && options.method === "PATCH") { release = { ...release, ...options.body }; return release; }
    if (path === "/releases/42") return release;
    throw new Error(`Unexpected endpoint: ${path}`);
  };
  return { api, requests, current: () => release };
}

test("Windows publication stages a draft and validates all assets before publishing an indev prerelease", async () => {
  const fixtureApi = fixture();
  await publishWindows({ manifest, files, appleState: "available" }, fixtureApi.api);
  const release = fixtureApi.current();
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, "false");
  assert.equal(release.target_commitish, manifest.sourceSha);
  assert.equal(release.assets.length, 3);
  assert.equal(fixtureApi.requests.find(item => item.path === "/releases").body.draft, true);
  assert.match(release.body, /unsigned/i);
});

test("Apple failure blocks normal release publication and missing assets cannot publish", async () => {
  const releaseManifest = { ...manifest, channel: "release" };
  await assert.rejects(publishWindows({ manifest: releaseManifest, files, appleState: "failed" }, fixture().api), /Apple/);
  await assert.rejects(publishWindows({ manifest, files: new Map(), appleState: "available" }, fixture().api), /allowlist/);
});

test("a published release cannot be overwritten on a retry", async () => {
  const fixtureApi = fixture();
  await publishWindows({ manifest, files, appleState: "available" }, fixtureApi.api);
  await assert.rejects(publishWindows({ manifest, files, appleState: "available" }, fixtureApi.api), /immutable/);
});

test("checksum disagreement blocks all publication writes", async () => {
  const fixtureApi = fixture();
  const corrupt = new Map(files);
  corrupt.set(installer, Buffer.from("changed"));
  await assert.rejects(publishWindows({ manifest, files: corrupt, appleState: "available" }, fixtureApi.api), /checksum/i);
  assert.equal(fixtureApi.requests.filter(item => item.method).length, 0);
});
