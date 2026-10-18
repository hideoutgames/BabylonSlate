import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { patchNotesMarkdown, validateChangelog, validatePatchNotes } from "./changelog.mjs";
import { buildManifest } from "./metadata.mjs";

const entry = (version = "1.2.3") => ({ version, title: "Editor Updates", changes: ["Projects reopen faster."] });

test("bundled changelog includes current and older versions in numeric order", () => {
  const result = validateChangelog({ schemaVersion: 1, releases: [entry("1.9.0"), entry("1.11.0"), entry("1.2.0"), entry("1.10.0")] }, "1.10.0");
  assert.deepEqual(result.map(notes => notes.version), ["1.10.0", "1.9.0", "1.2.0"]);
  assert.deepEqual(result[0].changes, ["Projects reopen faster."]);
});

test("missing, empty, mismatched and duplicate patch notes block builds", () => {
  for (const notes of [undefined, { ...entry(), title: " " }, { ...entry(), changes: [] }, { ...entry(), changes: [" "] }, entry("1.2.4"),
    { ...entry(), title: "Two\nLines" }, { ...entry(), changes: ["Ends the block -->"] }]) {
    assert.throws(() => validatePatchNotes(notes, "1.2.3"), /Patch notes/);
  }
  assert.throws(() => validateChangelog({ schemaVersion: 1, releases: [entry("1.2.2")] }, "1.2.3"), /Patch notes/);
  assert.throws(() => validateChangelog({ schemaVersion: 1, releases: [entry(), entry()] }, "1.2.3"), /Duplicate/);
});

test("the source changelog has notes for the declared version", () => {
  const read = file => JSON.parse(readFileSync(new URL(`../../release/${file}`, import.meta.url), "utf8"));
  const { version } = read("version.json");
  const releases = validateChangelog(read("changelog.json"), version);
  assert.equal(releases[0].version, version);
});

test("test and release metadata carry the required version's notes for either native platform", () => {
  for (const channel of ["test", "release"]) {
    for (const platforms of ["windows", "ipados"]) {
      const request = { channel, platforms, platform: platforms, sourceSha: "a".repeat(40), runNumber: 20, runAttempt: 1 };
      assert.throws(() => buildManifest({ version: "1.2.3" }, request), /Patch notes/);
      const manifest = buildManifest({ version: "1.2.3" }, { ...request, patchNotes: entry() });
      assert.deepEqual(manifest.patchNotes, entry());
    }
  }
});

test("release bodies receive trimmed notes in the exact marked block the app parses", () => {
  const notes = { version: "0.0.1", title: " Updates And Release News ", changes: [" A", "B "] };
  assert.equal(
    patchNotesMarkdown(notes),
    '<!-- haptic-release-notes version="0.0.1" -->\n## Updates And Release News\n\n- A\n- B\n<!-- /haptic-release-notes -->',
  );
});
