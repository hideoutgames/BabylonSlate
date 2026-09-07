import assert from "node:assert/strict";
import test from "node:test";
import { finalizeTestFlight, validatePrivateGroups } from "./testflight.mjs";

const identity = { applicationVersion: "0.0.1", appleMarketingVersion: "0.0.1", appleBuildNumber: "417.0.1", channel: "test", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1, windowsVersion: "0.0.1-indev.417.1" };
const group = { id: "test", attributes: { name: "Test Builds", publicLinkEnabled: false, hasAccessToAllBuilds: false, isInternalGroup: false } };
const releaseGroup = { id: "release", attributes: { ...group.attributes, name: "Release Candidates" } };
test("private groups reject public enrollment and automatic access to every build", () => {
  assert.doesNotThrow(() => validatePrivateGroups([group, releaseGroup], { test: "test", release: "release" }));
  for (const patch of [{ publicLinkEnabled: true }, { hasAccessToAllBuilds: true }]) {
    assert.throws(() => validatePrivateGroups([{ ...group, attributes: { ...group.attributes, ...patch } }, releaseGroup], { test: "test", release: "release" }));
  }
});

function fixture(states = ["VALID"]) {
  let assigned = false;
  let now = 0;
  const writes = [];
  const build = () => ({ id: "build1", type: "builds", attributes: { version: "417.0.1", processingState: states.length > 1 ? states.shift() : states[0] }, relationships: { preReleaseVersion: { data: { id: "version1" } }, buildBetaDetail: { data: { id: "detail1" } } } });
  const api = async (path, options = {}) => {
    if (options.method) { writes.push({ path, ...options }); if (path.endsWith("/relationships/builds")) assigned = true; return {}; }
    if (path.startsWith("/v1/builds?")) return { data: [build()], included: [{ id: "version1", type: "preReleaseVersions", attributes: { version: "0.0.1", platform: "IOS" } }, { id: "detail1", type: "buildBetaDetails", attributes: { externalBuildState: "IN_BETA_TESTING" } }] };
    if (path === "/v1/builds/build1/betaGroups?limit=200") return { data: assigned ? [group] : [] };
    if (path.startsWith("/v1/buildBetaLocalizations?")) return { data: [] };
    throw new Error(`Unexpected endpoint ${path}`);
  };
  return { api, writes, now: () => now, sleep: async ms => { now += ms; } };
}

test("finalization assigns only the selected private group and writes exact identity without reuploading", async () => {
  const f = fixture();
  const result = await finalizeTestFlight({ identity, appId: "123", group, timeoutMs: 100 }, f);
  assert.equal(result.state, "available");
  assert.equal(f.writes.filter(item => item.path.endsWith("/relationships/builds")).length, 1);
  assert.ok(f.writes.some(item => item.path === "/v1/betaGroups/test/relationships/builds"));
  assert.ok(f.writes.some(item => item.body?.data?.attributes?.whatsNew?.includes(identity.sourceSha)));
  assert.equal(f.writes.some(item => /upload|appStoreVersion|betaAppReviewSubmission/.test(item.path)), false);
});

test("bounded processing wait returns processing rather than successful availability", async () => {
  const f = fixture(["PROCESSING"]);
  assert.equal((await finalizeTestFlight({ identity, appId: "123", group, timeoutMs: 100 }, f)).state, "processing");
  assert.equal(f.writes.length, 0);
});
