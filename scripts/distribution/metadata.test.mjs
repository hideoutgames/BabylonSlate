import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest } from "./metadata.mjs";

test("metadata uses the platform job attempt and copies only non-sensitive toolchain fields", () => {
  const manifest = buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, {
    channel: "test", platforms: "both", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 2,
    toolchains: { node: "22.22.0", pnpm: "10.33.3", electron: "44.2.0", token: "secret", privateKey: "secret" },
  });
  assert.equal(manifest.appleBuildNumber, "417.0.2");
  assert.equal(manifest.windowsVersion, "0.0.1-indev.417.2");
  assert.deepEqual(manifest.toolchains, { node: "22.22.0", pnpm: "10.33.3", electron: "44.2.0" });
  assert.equal(JSON.stringify(manifest).includes("secret"), false);
});
