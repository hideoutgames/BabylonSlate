const numericVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exactSha = /^[a-f0-9]{40}$/;

export const PLATFORM_CHOICES = ["all", "desktop", "mobile", "ipados", "android", "windows", "macos", "linux"];
export const GITHUB_RELEASE_PLATFORMS = ["windows", "macos", "linux", "android"];
const platforms = ["android", "ipados", "linux", "macos", "windows"];

export function requestedPlatforms(choice) {
  const choices = {
    all: platforms,
    desktop: ["linux", "macos", "windows"],
    mobile: ["android", "ipados"],
  };
  const requested = choices[choice] ?? (platforms.includes(choice) ? [choice] : undefined);
  if (!requested) throw new Error("Unsupported platforms");
  return [...requested].sort();
}

export function existingAppleIdentity(declared, request) {
  requireValue(request.platforms === "ipados", "Finalization-only requests require ipados");
  requireValue(numericVersion.test(request.existingBuildNumber), "An exact existing Apple build number is required");
  const [sequence, channelCode, attempt] = request.existingBuildNumber.split(".").map(Number);
  requireValue(channelCode === (request.channel === "test" ? 0 : 1), "Existing Apple build channel differs from request");
  const identity = createIdentity({ ...request, declaredVersion: declared.version, appleSequenceOffset: declared.appleSequenceOffset, runNumber: sequence - declared.appleSequenceOffset, runAttempt: attempt });
  requireValue(identity.appleBuildNumber === request.existingBuildNumber, "Existing Apple identity is not canonical");
  return identity;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function integer(value, min, max, name) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `${name} outside supported bounds`);
}

export function createIdentity(request) {
  const { version, declaredVersion, channel, sourceSha, runNumber, runAttempt, appleSequenceOffset = 0 } = request;
  requireValue(numericVersion.test(version) && version === declaredVersion, "Version must match the numeric version at the selected commit");
  requireValue(["test", "release"].includes(channel), "Unsupported channel");
  requireValue(PLATFORM_CHOICES.includes(request.platforms), "Unsupported platforms");
  requireValue(exactSha.test(sourceSha), "An exact source SHA is required");
  integer(runNumber, 1, Number.MAX_SAFE_INTEGER, "Run number");
  integer(runAttempt, 1, 99, "Run attempt");
  integer(appleSequenceOffset, 0, 9998, "Apple sequence offset");
  const sequence = runNumber + appleSequenceOffset;
  integer(sequence, 1, 9999, "Apple sequence; migrate the sequence explicitly before exhaustion");
  const channelCode = channel === "test" ? 0 : 1;
  const packageVersion = channel === "test" ? `${version}-indev.${runNumber}.${runAttempt}` : `${version}-release`;
  return {
    schemaVersion: 2,
    applicationVersion: version,
    channel,
    platforms: request.platforms,
    sourceSha,
    runNumber,
    runAttempt,
    packageVersion,
    androidVersionCode: sequence * 1000 + channelCode * 100 + runAttempt,
    appleMarketingVersion: version,
    appleBuildNumber: `${sequence}.${channelCode}.${runAttempt}`,
    tag: `v${packageVersion}`,
    title: `[${channel.toUpperCase()}] BabylonSlate ${packageVersion}`,
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
  requireValue(!release || release.target_commitish === identity.sourceSha, "Draft release source must be the exact validated commit");
  return release ? "resume-draft" : "create-draft";
}

export function artifactNames(platform, version) {
  const release = version.endsWith("-release");
  if (platform === "windows") {
    const installer = `BabylonSlate-${version}-x64.exe`;
    return [installer, ...(release ? ["latest.yml", `${installer}.blockmap`] : [])];
  }
  if (platform === "macos") {
    const names = ["arm64", "x64"].flatMap(arch => [
      `BabylonSlate-${version}-${arch}.dmg`,
      `BabylonSlate-${version}-${arch}.zip`,
    ]);
    return [...names, ...(release ? ["latest-mac.yml"] : [])];
  }
  if (platform === "linux") return [`BabylonSlate-${version}-x64.AppImage`, ...(release ? ["latest-linux.yml"] : [])];
  if (platform === "android") return [`BabylonSlate-${version}-android.apk`];
  throw new Error("Unsupported artifact platform");
}

export function platformArtifactNames(platform, version) {
  return [...artifactNames(platform, version), "SHA256SUMS.txt", "build-manifest.json"];
}

export function releaseAssetNames(requested, version) {
  const names = new Set(["SHA256SUMS.txt", "build-manifest.json"]);
  for (const platform of requested) {
    requireValue(GITHUB_RELEASE_PLATFORMS.includes(platform), "Unsupported artifact platform");
    for (const name of artifactNames(platform, version)) names.add(name);
  }
  return [...names];
}

export function validateArtifacts(expected, names) {
  requireValue(names.length === expected.length && new Set(names).size === names.length && expected.every(name => names.includes(name)), "Artifacts must exactly match the public allowlist");
}
