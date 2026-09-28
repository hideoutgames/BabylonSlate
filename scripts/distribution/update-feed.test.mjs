import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateUpdateFeed } from "./update-feed.mjs";

const sha512 = bytes => createHash("sha512").update(bytes).digest("base64");
const entry = (name, bytes) => ({ url: name, sha512: sha512(bytes), size: bytes.length });

function feed(platform, version, names) {
  const feedName = { windows: "latest.yml", macos: "latest-mac.yml", linux: "latest-linux.yml" }[platform];
  const files = new Map(names.map(name => [name, Buffer.from(`${name} bytes`)]));
  const entries = names.map(name => entry(name, files.get(name)));
  files.set(feedName, Buffer.from(JSON.stringify({ version, files: entries, path: entries[0].url, sha512: entries[0].sha512 })));
  return files;
}

test("Windows feed identifies and hashes the installer", () => {
  const version = "1.2.3-release";
  const files = feed("windows", version, [`BabylonSlate-${version}-x64.exe`]);
  assert.doesNotThrow(() => validateUpdateFeed("windows", version, files));
  const metadata = JSON.parse(files.get("latest.yml"));
  delete metadata.path;
  files.set("latest.yml", Buffer.from(JSON.stringify(metadata)));
  assert.doesNotThrow(() => validateUpdateFeed("windows", version, files));
});

test("macOS feed validates both update zips and listed DMGs", () => {
  const version = "1.2.3-release";
  const files = feed("macos", version, [
    `BabylonSlate-${version}-arm64.zip`, `BabylonSlate-${version}-x64.zip`,
    `BabylonSlate-${version}-arm64.dmg`, `BabylonSlate-${version}-x64.dmg`,
  ]);
  assert.doesNotThrow(() => validateUpdateFeed("macos", version, files));
});

test("Linux feed identifies and hashes the AppImage", () => {
  const version = "1.2.3-release";
  const files = feed("linux", version, [`BabylonSlate-${version}-x64.AppImage`]);
  assert.doesNotThrow(() => validateUpdateFeed("linux", version, files));
});

test("feed mismatches are rejected", () => {
  const version = "1.2.3-release";
  const files = feed("windows", version, [`BabylonSlate-${version}-x64.exe`]);
  const metadata = JSON.parse(files.get("latest.yml"));
  metadata.files[0].size -= 1;
  files.set("latest.yml", Buffer.from(JSON.stringify(metadata)));
  assert.throws(() => validateUpdateFeed("windows", version, files), /metadata/);
});
