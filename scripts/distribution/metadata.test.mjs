import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest } from "./metadata.mjs";

const request = {
  channel: "test", platforms: "all", platform: "macos", macosSigned: false, sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 2,
  toolchains: { node: "22.22.0", pnpm: "10.33.3", electron: "44.2.0", jdk: "21.0.5", gradle: "8.14.3", androidSdk: "36", token: "secret", privateKey: "secret" },
};

test("metadata records platform properties and copies only non-sensitive toolchain fields", () => {
  const manifest = buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, request);
  assert.equal(manifest.appleBuildNumber, "417.0.2");
  assert.equal(manifest.packageVersion, "0.0.1-indev.417.2");
  assert.equal(manifest.androidVersionCode, 417002);
  assert.equal(manifest.platform, "macos");
  assert.equal(manifest.macosSigned, false);
  assert.deepEqual(manifest.toolchains, { node: "22.22.0", pnpm: "10.33.3", electron: "44.2.0", jdk: "21.0.5", gradle: "8.14.3", androidSdk: "36" });
  assert.equal(JSON.stringify(manifest).includes("secret"), false);
});

test("metadata requires a supported platform and limits macOS signing state", () => {
  assert.throws(() => buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, { ...request, platform: "web" }), /platform/);
  assert.throws(() => buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, { ...request, platform: "linux", macosSigned: false }), /macosSigned/);
  assert.throws(() => buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, { ...request, macosSigned: "yes" }), /macosSigned/);
});
