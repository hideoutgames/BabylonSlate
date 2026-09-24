import assert from "node:assert/strict";
import test from "node:test";
import { archiveArguments, exportOptions, validateAppleBundle, validateAppleConfiguration, validateAppleProvisioningProfile, appleAvailability } from "./apple-contract.mjs";

const identity = { applicationVersion: "0.0.1", appleMarketingVersion: "0.0.1", appleBuildNumber: "417.0.1", channel: "test" };
const info = { CFBundleIdentifier: "no.hideout.babylonslate", CFBundleShortVersionString: "0.0.1", CFBundleVersion: "417.0.1", UIDeviceFamily: [1, 2], CFBundleDisplayName: "BabylonSlate", DTSDKName: "iphoneos26.5", ITSAppUsesNonExemptEncryption: false };
const entitlements = {
  "application-identifier": "TEAM123456.no.hideout.babylonslate",
  "com.apple.developer.team-identifier": "TEAM123456",
  "get-task-allow": false,
  "beta-reports-active": true,
  "com.apple.developer.kernel.increased-memory-limit": true,
  "com.apple.developer.kernel.extended-virtual-addressing": true,
};
const signing = { teamId: "TEAM123456", signingIdentity: "0123456789abcdef0123456789abcdef01234567", profileUuid: "12345678-1234-1234-1234-123456789abc" };
test("archive targets Release generic iOS devices and export never changes the assigned build", () => {
  const args = archiveArguments(identity, "/private/App.xcarchive", signing);
  assert.ok(args.includes("Release"));
  assert.ok(args.includes("generic/platform=iOS"));
  assert.ok(args.includes("CURRENT_PROJECT_VERSION=417.0.1"));
  assert.ok(args.includes("CODE_SIGNING_ALLOWED=YES"));
  assert.ok(args.includes("CODE_SIGN_STYLE=Manual"));
  assert.ok(args.includes("CODE_SIGN_IDENTITY=0123456789abcdef0123456789abcdef01234567"));
  assert.ok(args.includes("DEVELOPMENT_TEAM=TEAM123456"));
  assert.ok(args.includes("BABYLONSLATE_PROVISIONING_PROFILE_SPECIFIER=12345678-1234-1234-1234-123456789abc"));
  assert.ok(args.every(arg => !arg.startsWith("PROVISIONING_PROFILE_SPECIFIER=")));
  assert.ok(!args.join(" ").includes("simulator"));
  const options = exportOptions("TEAM123456", "profile-uuid");
  assert.equal(options.method, "app-store-connect");
  assert.equal(options.manageAppVersionAndBuildNumber, false);
  assert.equal(options.testFlightInternalTestingOnly, false);
});

test("exported app must have the intended identity, universal device family and distribution entitlements", () => {
  assert.doesNotThrow(() => validateAppleBundle(identity, info, entitlements, "TEAM123456"));
  for (const patch of [{ UIDeviceFamily: [2] }, { CFBundleVersion: "418.0.1" }, { CFBundleIdentifier: "other" }, { DTSDKName: "iphoneos18.5" }, { CFBundleDisplayName: "BabylonSlate TEST" }]) {
    assert.throws(() => validateAppleBundle(identity, { ...info, ...patch }, entitlements, "TEAM123456"));
  }
  assert.throws(() => validateAppleBundle(identity, info, { ...entitlements, "get-task-allow": true }, "TEAM123456"));
  assert.throws(() => validateAppleBundle(identity, info, { ...entitlements, "com.apple.security.application-groups": ["group.other"] }, "TEAM123456"), /Unexpected entitlement/);
  assert.throws(() => validateAppleBundle(identity, info, { ...entitlements, "keychain-access-groups": ["TEAM123456.other"] }, "TEAM123456"), /Unexpected keychain/);
});

test("a dropped, disabled or mistyped memory entitlement prevents upload", () => {
  for (const key of ["com.apple.developer.kernel.increased-memory-limit", "com.apple.developer.kernel.extended-virtual-addressing"]) {
    const missing = { ...entitlements };
    delete missing[key];
    for (const exported of [missing, { ...entitlements, [key]: false }, { ...entitlements, [key]: "true" }]) {
      assert.throws(() => validateAppleBundle(identity, info, exported, "TEAM123456"), /memory entitlements/);
    }
  }
});

test("manual signing requires a current App Store profile with the requested memory capabilities", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const profile = { UUID: "12345678-1234-1234-1234-123456789abc", TeamIdentifier: ["TEAM123456"], Entitlements: entitlements, ExpirationDate: "2027-09-24T00:00:00Z" };
  assert.doesNotThrow(() => validateAppleProvisioningProfile(profile, "TEAM123456", now));
  for (const patch of [
    { ExpirationDate: "2026-09-24T00:00:00Z" },
    { ExpirationDate: "not a date" },
    { UUID: "invalid" },
    { TeamIdentifier: ["OTHER12345"] },
    { ProvisionedDevices: ["device"] },
    { ProvisionsAllDevices: true },
    { Entitlements: { ...entitlements, "get-task-allow": true } },
    { Entitlements: { ...entitlements, "application-identifier": "TEAM123456.*" } },
  ]) assert.throws(() => validateAppleProvisioningProfile({ ...profile, ...patch }, "TEAM123456", now), /profile/);
  for (const key of ["com.apple.developer.kernel.increased-memory-limit", "com.apple.developer.kernel.extended-virtual-addressing"]) {
    const previous = { ...entitlements };
    delete previous[key];
    assert.throws(() => validateAppleProvisioningProfile({ ...profile, Entitlements: previous }, "TEAM123456", now), /memory entitlements/);
  }
});

test("missing credentials or undeclared encryption classification fail before native work", () => {
  assert.throws(() => validateAppleConfiguration({}, identity), /configuration/);
});

test("processing and beta review are not reported as tester availability", () => {
  assert.equal(appleAvailability("PROCESSING", "PROCESSING", false), "processing");
  assert.equal(appleAvailability("VALID", "WAITING_FOR_BETA_REVIEW", true), "awaiting-beta-review");
  assert.equal(appleAvailability("VALID", "IN_BETA_TESTING", true), "available");
  assert.equal(appleAvailability("VALID", "IN_BETA_TESTING", false), "uploaded");
  assert.equal(appleAvailability("FAILED", "PROCESSING_EXCEPTION", false), "failed");
  assert.equal(appleAvailability("VALID", "MISSING_EXPORT_COMPLIANCE", false), "failed");
});
