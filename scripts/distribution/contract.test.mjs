import assert from "node:assert/strict";
import test from "node:test";
import { artifactNames, createIdentity, existingAppleIdentity, assertAppleBuildAvailable, platformArtifactNames, releaseAssetNames, releaseDisposition, requestedPlatforms, validateArtifacts, validateChecks, validateSource } from "./contract.mjs";

const request = { version: "1.2.3", declaredVersion: "1.2.3", channel: "test", platforms: "all", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1, appleSequenceOffset: 0 };

test("platform choices expand to sorted concrete destinations", () => {
  assert.deepEqual(requestedPlatforms("all"), ["android", "ipados", "linux", "macos", "windows"]);
  assert.deepEqual(requestedPlatforms("desktop"), ["linux", "macos", "windows"]);
  assert.deepEqual(requestedPlatforms("mobile"), ["android", "ipados"]);
  assert.deepEqual(requestedPlatforms("linux"), ["linux"]);
  assert.throws(() => requestedPlatforms("both"), /Unsupported platforms/);
});

test("test and release identities cannot be promoted by flipping a release flag", () => {
  const candidate = createIdentity(request);
  assert.equal(candidate.schemaVersion, 2);
  assert.equal(candidate.packageVersion, "1.2.3-indev.417.1");
  assert.equal(candidate.androidVersionCode, 417001);
  assert.equal(candidate.appleBuildNumber, "417.0.1");
  assert.equal(candidate.tag, "v1.2.3-indev.417.1");
  assert.equal(candidate.prerelease, true);
  assert.equal(candidate.makeLatest, "false");
  const release = createIdentity({ ...request, channel: "release", runNumber: 418 });
  assert.equal(release.packageVersion, "1.2.3-release");
  assert.equal(release.androidVersionCode, 418101);
  assert.equal(release.appleBuildNumber, "418.1.1");
  assert.equal(release.prerelease, false);
  assert.equal(release.makeLatest, "legacy");
  assert.equal(release.testFlightGroup, "Release Candidates");
});

test("Apple counters reject overflow and preserve the actual job attempt", () => {
  assert.equal(createIdentity({ ...request, runAttempt: 2, appleSequenceOffset: 10 }).appleBuildNumber, "427.0.2");
  for (const patch of [{ runNumber: 10000 }, { runNumber: 0 }, { runAttempt: 100 }, { runAttempt: 0 }, { appleSequenceOffset: -1 }, { runNumber: 1.5 }]) assert.throws(() => createIdentity({ ...request, ...patch }));
});

test("input assertions reject invalid versions, channels, platforms and nonexact commits", () => {
  for (const patch of [{ version: "1.0.0" }, { version: "01.2.3", declaredVersion: "01.2.3" }, { channel: "beta" }, { platforms: "both" }, { sourceSha: "main" }]) assert.throws(() => createIdentity({ ...request, ...patch }));
});

test("duplicate or superseded Apple builds require a fresh dispatch", () => {
  assert.doesNotThrow(() => assertAppleBuildAvailable("418.0.1", ["417.1.99"]));
  for (const existing of [["418.0.1"], ["419.0.1"], ["418.1.1"]]) assert.throws(() => assertAppleBuildAvailable("418.0.1", existing), /fresh dispatch/i);
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
  for (const patch of [{ workflowRef: "refs/heads/feature" }, { eventName: "push" }, { protectedMain: false }, { reachable: false }, { sourceSha: "HEAD" }]) assert.throws(() => validateSource({ ...source, ...patch }));
});

test("checks must succeed for the exact source including every browser shard", () => {
  const names = ["static", "unit", ...Array.from({ length: 7 }, (_, i) => `e2e (${i + 1})`)];
  const checks = names.map(name => ({ name, head_sha: request.sourceSha, status: "completed", conclusion: "success" }));
  assert.doesNotThrow(() => validateChecks(request.sourceSha, checks, names));
  assert.throws(() => validateChecks(request.sourceSha, checks.slice(1), names));
  for (const conclusion of ["skipped", "cancelled", "failure", null]) assert.throws(() => validateChecks(request.sourceSha, [{ ...checks[0], conclusion }, ...checks.slice(1)], names));
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
  for (const target_commitish of ["b".repeat(40), "main", undefined]) assert.throws(() => releaseDisposition(identity, null, { draft: true, target_commitish }), /source/i);
});

test("platform and merged release assets are exact public allowlists", () => {
  const testVersion = "1.2.3-indev.417.1";
  assert.deepEqual(artifactNames("windows", testVersion), [`BabylonSlate-${testVersion}-x64.exe`]);
  assert.deepEqual(artifactNames("android", testVersion), [`BabylonSlate-${testVersion}-android.apk`]);
  const releaseVersion = "1.2.3-release";
  assert.deepEqual(artifactNames("macos", releaseVersion), [
    `BabylonSlate-${releaseVersion}-arm64.dmg`,
    `BabylonSlate-${releaseVersion}-arm64.zip`,
    `BabylonSlate-${releaseVersion}-x64.dmg`,
    `BabylonSlate-${releaseVersion}-x64.zip`,
    "latest-mac.yml",
  ]);
  assert.ok(artifactNames("linux", releaseVersion).includes("latest-linux.yml"));
  const files = platformArtifactNames("windows", testVersion);
  assert.doesNotThrow(() => validateArtifacts(files, files));
  assert.throws(() => validateArtifacts(files, [...files, "App.ipa"]), /allowlist/);
  assert.throws(() => validateArtifacts(files, files.slice(1)), /allowlist/);
  assert.throws(() => validateArtifacts(files, [...files.slice(1), files[1]]), /allowlist/);
  const release = releaseAssetNames(["windows", "android"], releaseVersion);
  assert.ok(release.includes("build-manifest.json") && release.includes("SHA256SUMS.txt"));
  assert.ok(release.includes(`BabylonSlate-${releaseVersion}-android.apk`));
});
