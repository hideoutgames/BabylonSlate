const numericVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exactSha = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function integer(value, min, max, name) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `${name} outside supported bounds`);
}

export function createIdentity(request) {
  const { version, declaredVersion, channel, platforms, sourceSha, runNumber, runAttempt, appleSequenceOffset = 0 } = request;
  requireValue(numericVersion.test(version) && version === declaredVersion, "Version must match the numeric version at the selected commit");
  requireValue(["test", "release"].includes(channel), "Unsupported channel");
  requireValue(["ipados", "windows", "both"].includes(platforms), "Unsupported platforms");
  requireValue(exactSha.test(sourceSha), "An exact source SHA is required");
  integer(runNumber, 1, Number.MAX_SAFE_INTEGER, "Run number");
  integer(runAttempt, 1, 99, "Run attempt");
  integer(appleSequenceOffset, 0, 9998, "Apple sequence offset");
  const sequence = runNumber + appleSequenceOffset;
  integer(sequence, 1, 9999, "Apple sequence; migrate the sequence explicitly before exhaustion");
  const windowsVersion = channel === "test" ? `${version}-test.${runNumber}.${runAttempt}` : version;
  return {
    schemaVersion: 1,
    applicationVersion: version,
    channel,
    platforms,
    sourceSha,
    runNumber,
    runAttempt,
    windowsVersion,
    appleMarketingVersion: version,
    appleBuildNumber: `${sequence}.${channel === "test" ? 0 : 1}.${runAttempt}`,
    tag: `v${windowsVersion}`,
    title: `[${channel.toUpperCase()}] BabylonSlate ${windowsVersion}`,
    prerelease: channel === "test",
    makeLatest: channel === "test" ? "false" : "legacy",
    testFlightGroup: channel === "test" ? "Test Builds" : "Release Candidates",
  };
}

export function assertAppleBuildAvailable(candidate, existing) {
  function parts(value) {
    requireValue(numericVersion.test(value), "Unrecognized Apple build number; audit sequence before continuing");
    return value.split(".").map(Number);
  }
  const wanted = parts(candidate);
  for (const value of existing) {
    const other = parts(value);
    const difference = wanted.map((part, index) => part - other[index]).find(part => part !== 0) ?? 0;
    requireValue(difference > 0, "Apple build duplicate or superseded; make a fresh dispatch");
  }
}

export function validateSource({ workflowRef, eventName, protectedMain, reachable, sourceSha }) {
  requireValue(workflowRef === "refs/heads/main" && eventName === "workflow_dispatch" && protectedMain === true && reachable === true && exactSha.test(sourceSha), "Distribution requires a manual main workflow and an exact commit reachable from protected main");
}

export function validateChecks(sourceSha, checks, requiredNames) {
  requireValue(requiredNames.length > 0, "Required checks must be configured");
  for (const name of requiredNames) {
    const check = checks.find(item => item.name === name && item.head_sha === sourceSha);
    requireValue(check?.status === "completed" && check.conclusion === "success", `Required check has not succeeded: ${name}`);
  }
}

export function releaseDisposition(identity, tagSha, release) {
  requireValue(!tagSha || tagSha === identity.sourceSha, "Existing tag points to another source commit");
  requireValue(!release || release.draft === true, "Published releases are immutable; choose a new version or test dispatch");
  return release ? "resume-draft" : "create-draft";
}

export function validateArtifacts(version, names) {
  const expected = [`BabylonSlate-${version}-x64.exe`, "SHA256SUMS.txt", "build-manifest.json"];
  requireValue(names.length === expected.length && new Set(names).size === names.length && expected.every(name => names.includes(name)), "Windows artifacts must exactly match the public allowlist");
}
