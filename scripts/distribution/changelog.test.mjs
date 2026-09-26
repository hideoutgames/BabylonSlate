import assert from "node:assert/strict";
import test from "node:test";
import { validateChangelog, validatePatchNotes } from "./changelog.mjs";
import { buildManifest } from "./metadata.mjs";

const entry = (version = "1.2.3") => ({ version, title: "Editor Updates", changes: ["Projects reopen faster."] });

test("bundled changelog includes current and older versions in numeric order", () => {
  const result = validateChangelog({ schemaVersion: 1, releases: [entry("1.9.0"), entry("1.11.0"), entry("1.2.0"), entry("1.10.0")] }, "1.10.0");
  assert.deepEqual(result.map(notes => notes.version), ["1.10.0", "1.9.0", "1.2.0"]);
  assert.deepEqual(result[0].changes, ["Projects reopen faster."]);
});

test("missing, empty, mismatched and duplicate patch notes block builds", () => {
  for (const notes of [undefined, { ...entry(), title: " " }, { ...entry(), changes: [] }, { ...entry(), changes: [" "] }, entry("1.2.4")]) {
    assert.throws(() => validatePatchNotes(notes, "1.2.3"), /Patch notes/);
  }
  assert.throws(() => validateChangelog({ schemaVersion: 1, releases: [entry("1.2.2")] }, "1.2.3"), /Patch notes/);
  assert.throws(() => validateChangelog({ schemaVersion: 1, releases: [entry(), entry()] }, "1.2.3"), /Duplicate/);
});

test("release metadata carries the required version's notes for either native platform", () => {
  for (const platforms of ["windows", "ipados"]) {
    const request = { channel: "release", platforms, sourceSha: "a".repeat(40), runNumber: 20, runAttempt: 1 };
    assert.throws(() => buildManifest({ version: "1.2.3" }, request), /Patch notes/);
    const manifest = buildManifest({ version: "1.2.3" }, { ...request, patchNotes: entry() });
    assert.deepEqual(manifest.patchNotes, entry());
  }
});
