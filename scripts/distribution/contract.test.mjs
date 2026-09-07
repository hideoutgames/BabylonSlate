import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity, existingAppleIdentity, assertAppleBuildAvailable, validateSource, validateChecks, releaseDisposition, validateArtifacts } from "./contract.mjs";

const request = { version: "1.2.3", declaredVersion: "1.2.3", channel: "test", platforms: "both", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1, appleSequenceOffset: 0 };

test("test and release identities cannot be promoted by flipping a release flag", () => {
  const candidate = createIdentity(request);
  assert.equal(candidate.windowsVersion, "1.2.3-indev.417.1");
  assert.equal(candidate.appleBuildNumber, "417.0.1");
  assert.equal(candidate.tag, "v1.2.3-indev.417.1");
  assert.equal(candidate.prerelease, true);
  assert.equal(candidate.makeLatest, "false");
  const release = createIdentity({ ...request, channel: "release", runNumber: 418 });
  assert.equal(release.windowsVersion, "1.2.3-release");
  assert.equal(release.appleBuildNumber, "418.1.1");
  assert.equal(release.prerelease, false);
  assert.equal(release.makeLatest, "legacy");
  assert.equal(release.testFlightGroup, "Release Candidates");
});

test("Apple counters reject overflow and preserve the actual job attempt", () => {
  assert.equal(createIdentity({ ...request, runAttempt: 2, appleSequenceOffset: 10 }).appleBuildNumber, "427.0.2");
  for (const patch of [{ runNumber: 10000 }, { runNumber: 0 }, { runAttempt: 100 }, { runAttempt: 0 }, { appleSequenceOffset: -1 }, { runNumber: 1.5 }]) {
    assert.throws(() => createIdentity({ ...request, ...patch }));
  }
});

test("input assertions reject invalid versions, channels, platforms and nonexact commits", () => {
  for (const patch of [{ version: "1.0.0" }, { version: "01.2.3", declaredVersion: "01.2.3" }, { channel: "beta" }, { platforms: "linux" }, { sourceSha: "main" }]) {
    assert.throws(() => createIdentity({ ...request, ...patch }));
  }
});

test("duplicate or superseded Apple builds require a fresh dispatch", () => {
  assert.doesNotThrow(() => assertAppleBuildAvailable("418.0.1", ["417.1.99"]));
  for (const existing of [["418.0.1"], ["419.0.1"], ["418.1.1"]]) {
    assert.throws(() => assertAppleBuildAvailable("418.0.1", existing), /fresh dispatch/i);
  }
});

test("independent finalization preserves the original version, sequence, channel and build attempt", () => {
  const result = existingAppleIdentity({ version: "1.2.3", appleSequenceOffset: 10 }, { ...request, platforms: "ipados", existingBuildNumber: "427.0.2" });
  assert.equal(result.runNumber, 417);
  assert.equal(result.runAttempt, 2);
  assert.equal(result.appleBuildNumber, "427.0.2");
  assert.throws(() => existingAppleIdentity({ version: "1.2.3", appleSequenceOffset: 10 }, { ...request, platforms: "ipados", existingBuildNumber: "427.1.2" }), /channel/i);
});

test("only protected main workflow and reachable exact source commits are trusted", () => {
  const source = { workflowRef: "refs/heads/main", eventName: "workflow_dispatch", protectedMain: true, reachable: true, sourceSha: request.sourceSha };
  assert.doesNotThrow(() => validateSource(source));
  for (const patch of [{ workflowRef: "refs/heads/feature" }, { eventName: "push" }, { protectedMain: false }, { reachable: false }, { sourceSha: "HEAD" }]) {
    assert.throws(() => validateSource({ ...source, ...patch }));
  }
});

test("checks must succeed for the exact source including every browser shard", () => {
  const names = ["static", "unit", ...Array.from({ length: 7 }, (_, i) => `e2e (${i + 1})`)];
  const checks = names.map(name => ({ name, head_sha: request.sourceSha, status: "completed", conclusion: "success" }));
  assert.doesNotThrow(() => validateChecks(request.sourceSha, checks, names));
  assert.throws(() => validateChecks(request.sourceSha, checks.slice(1), names));
  for (const conclusion of ["skipped", "cancelled", "failure", null]) {
    assert.throws(() => validateChecks(request.sourceSha, [{ ...checks[0], conclusion }, ...checks.slice(1)], names));
  }
  assert.throws(() => validateChecks("b".repeat(40), checks, names));
});

test("published releases are immutable and tags cannot move", () => {
  const identity = createIdentity(request);
  assert.equal(releaseDisposition(identity, null, null), "create-draft");
  assert.throws(() => releaseDisposition(identity, "b".repeat(40), null));
  assert.throws(() => releaseDisposition(identity, request.sourceSha, { draft: false }));
  assert.equal(releaseDisposition(identity, request.sourceSha, { draft: true, target_commitish: request.sourceSha }), "resume-draft");
});

test("an untagged draft cannot publish a different or mutable source reference", () => {
  const identity = createIdentity(request);
  for (const target_commitish of ["b".repeat(40), "main", undefined]) {
    assert.throws(() => releaseDisposition(identity, null, { draft: true, target_commitish }), /source/i);
  }
});

test("public assets are an exact allowlist without private Apple outputs", () => {
  const version = "1.2.3-test.417.1";
  const files = [`BabylonSlate-${version}-x64.exe`, "SHA256SUMS.txt", "build-manifest.json"];
  assert.doesNotThrow(() => validateArtifacts(version, files));
  for (const extra of ["App.ipa", "logs.txt", "key.p12", "../build-manifest.json"]) {
    assert.throws(() => validateArtifacts(version, [...files, extra]));
  }
  assert.throws(() => validateArtifacts(version, files.slice(1)));
});
