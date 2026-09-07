export const APPLE_BUNDLE_ID = "no.hideout.babylonslate";

export function archiveArguments(identity, archivePath) {
  return ["-workspace", "ios/App/App.xcworkspace", "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archivePath, `MARKETING_VERSION=${identity.appleMarketingVersion}`, `CURRENT_PROJECT_VERSION=${identity.appleBuildNumber}`, "CODE_SIGNING_ALLOWED=NO", "archive"];
}

export function exportOptions(teamId, profileUuid) {
  return { method: "app-store-connect", destination: "export", signingStyle: "manual", signingCertificate: "Apple Distribution", teamID: teamId, provisioningProfiles: { [APPLE_BUNDLE_ID]: profileUuid }, manageAppVersionAndBuildNumber: false, testFlightInternalTestingOnly: false, uploadSymbols: false };
}

export function validateAppleBundle(identity, info, entitlements, teamId) {
  if (info.CFBundleIdentifier !== APPLE_BUNDLE_ID || info.CFBundleShortVersionString !== identity.appleMarketingVersion || info.CFBundleVersion !== identity.appleBuildNumber || JSON.stringify(info.UIDeviceFamily) !== "[2]" || info.CFBundleDisplayName !== "BabylonSlate" || !/^iphoneos(?:2[6-9]|[3-9]\d)\./.test(info.DTSDKName) || typeof info.ITSAppUsesNonExemptEncryption !== "boolean") throw new Error("Exported Apple bundle identity, target, SDK or encryption declaration is invalid");
  if (entitlements["application-identifier"] !== `${teamId}.${APPLE_BUNDLE_ID}` || entitlements["com.apple.developer.team-identifier"] !== teamId || entitlements["get-task-allow"] !== false || entitlements["beta-reports-active"] !== true) throw new Error("Exported Apple distribution entitlements are invalid");
  const allowed = new Set(["application-identifier", "com.apple.developer.team-identifier", "get-task-allow", "beta-reports-active", "keychain-access-groups"]);
  if (Object.keys(entitlements).some(key => !allowed.has(key))) throw new Error("Unexpected entitlement; audit it before distribution");
  if (entitlements["keychain-access-groups"]?.some(group => group !== `${teamId}.${APPLE_BUNDLE_ID}`)) throw new Error("Unexpected keychain access group");
}

export function validateAppleConfiguration(env, identity, signing = true) {
  const required = ["ASC_PRIVATE_KEY_P8_BASE64", "ASC_KEY_ID", "ASC_APP_ID", "APPLE_TEAM_ID", "APPLE_BUNDLE_ID", "APPLE_TEST_GROUP_ID", "APPLE_RELEASE_GROUP_ID"];
  if (signing) required.push("APPLE_DISTRIBUTION_P12_BASE64", "APPLE_DISTRIBUTION_PASSWORD", "APPLE_PROVISIONING_PROFILE_BASE64", "APPLE_PRIVACY_REVIEWED_VERSION", "APPLE_USES_NON_EXEMPT_ENCRYPTION");
  if (required.some(key => typeof env[key] !== "string" || !env[key]) || env.APPLE_BUNDLE_ID !== APPLE_BUNDLE_ID || !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID) || !/^[A-Z0-9]{10}$/.test(env.ASC_KEY_ID) || !/^\d+$/.test(env.ASC_APP_ID)) throw new Error("Apple environment configuration is missing or invalid");
  if (signing && (env.APPLE_PRIVACY_REVIEWED_VERSION !== identity.applicationVersion || !["true", "false"].includes(env.APPLE_USES_NON_EXEMPT_ENCRYPTION))) throw new Error("Apple privacy review and explicit encryption classification are required for this version");
  if (env.ASC_ISSUER_ID && !/^[a-fA-F0-9-]{36}$/.test(env.ASC_ISSUER_ID)) throw new Error("Invalid Apple issuer configuration");
  if ([env.APPLE_TEST_GROUP_ID, env.APPLE_RELEASE_GROUP_ID].some(id => !/^[a-fA-F0-9-]{36}$/.test(id)) || env.APPLE_TEST_GROUP_ID === env.APPLE_RELEASE_GROUP_ID) throw new Error("Distinct private TestFlight group identifiers are required");
}

export function appleAvailability(processingState, betaState, assigned) {
  if (["FAILED", "INVALID"].includes(processingState) || ["PROCESSING_EXCEPTION", "BETA_REJECTED", "EXPIRED", "MISSING_EXPORT_COMPLIANCE"].includes(betaState)) return "failed";
  if (processingState === "PROCESSING" || betaState === "PROCESSING" || betaState === "IN_EXPORT_COMPLIANCE_REVIEW") return "processing";
  if (["READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW"].includes(betaState)) return "awaiting-beta-review";
  if (processingState === "VALID" && ["IN_BETA_TESTING", "READY_FOR_BETA_TESTING", "BETA_APPROVED"].includes(betaState) && assigned) return "available";
  return "uploaded";
}
