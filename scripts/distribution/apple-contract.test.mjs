import assert from "node:assert/strict";
import test from "node:test";
import { archiveArguments, exportOptions, validateAppleBundle, validateAppleConfiguration, appleAvailability } from "./apple-contract.mjs";

const identity = { applicationVersion: "0.0.1", appleMarketingVersion: "0.0.1", appleBuildNumber: "417.0.1", channel: "test" };
test("archive targets Release generic iOS devices and export never changes the assigned build", () => {
  const args = archiveArguments(identity, "/private/App.xcarchive");
  assert.ok(args.includes("Release"));
  assert.ok(args.includes("generic/platform=iOS"));
  assert.ok(args.includes("CURRENT_PROJECT_VERSION=417.0.1"));
  assert.ok(!args.join(" ").includes("simulator"));
  const options = exportOptions("TEAM123456", "profile-uuid");
  assert.equal(options.method, "app-store-connect");
  assert.equal(options.manageAppVersionAndBuildNumber, false);
  assert.equal(options.testFlightInternalTestingOnly, false);
});

test("exported app must have the intended identity, iPad family and distribution entitlements", () => {
  const info = { CFBundleIdentifier: "no.hideout.babylonslate", CFBundleShortVersionString: "0.0.1", CFBundleVersion: "417.0.1", UIDeviceFamily: [2], CFBundleDisplayName: "BabylonSlate", DTSDKName: "iphoneos26.5", ITSAppUsesNonExemptEncryption: false };
  const entitlements = { "application-identifier": "TEAM123456.no.hideout.babylonslate", "com.apple.developer.team-identifier": "TEAM123456", "get-task-allow": false, "beta-reports-active": true };
  assert.doesNotThrow(() => validateAppleBundle(identity, info, entitlements, "TEAM123456"));
  for (const patch of [{ UIDeviceFamily: [1, 2] }, { CFBundleVersion: "418.0.1" }, { CFBundleIdentifier: "other" }, { DTSDKName: "iphoneos18.5" }, { CFBundleDisplayName: "BabylonSlate TEST" }]) {
    assert.throws(() => validateAppleBundle(identity, { ...info, ...patch }, entitlements, "TEAM123456"));
  }
  assert.throws(() => validateAppleBundle(identity, info, { ...entitlements, "get-task-allow": true }, "TEAM123456"));
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
