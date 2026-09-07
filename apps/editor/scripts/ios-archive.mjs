import { access, appendFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLE_BUNDLE_ID, archiveArguments, exportOptions, validateAppleBundle, validateAppleConfiguration } from "../../../scripts/distribution/apple-contract.mjs";
import { appleClient } from "../../../scripts/distribution/apple-api.mjs";
import { assertAppleBuildAvailable } from "../../../scripts/distribution/contract.mjs";
import { allApplePages, validatePrivateGroups } from "../../../scripts/distribution/testflight.mjs";
import { applePrivateDirectory, cleanupApple } from "../../../scripts/distribution/apple-cleanup.mjs";
import { privateCommand } from "../../../scripts/distribution/private-command.mjs";
import { validateAppIcon, validatePrivacyManifest } from "../../../scripts/distribution/apple-assets.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const editor = join(repo, "apps/editor");
let originalInfo;
let stage = "configuration";
let uploaded = false;
const infoPath = join(editor, "ios/App/App/Info.plist");
try {
  if (process.platform !== "darwin" || process.env.DEVELOPER_DIR !== "/Applications/Xcode_26.6.app/Contents/Developer") throw new Error("Pinned macOS toolchain required");
  const identity = JSON.parse(await readFile(join(repo, "release/generated/ipados-manifest.json"), "utf8"));
  validateAppleConfiguration(process.env, identity);
  const privateDir = applePrivateDirectory();
  await mkdir(privateDir, { mode: 0o700 });
  const run = (command, args, label, cwd = editor, env = process.env) => privateCommand(command, args, { directory: privateDir, stage: label, cwd, env });
  const plist = async (file, label) => JSON.parse(await run("python3", ["-c", "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], 'rb')), default=str))", file], label));

  stage = "asset-and-privacy-validation";
  const iconsDir = join(editor, "ios/App/App/Assets.xcassets/AppIcon.appiconset");
  const icons = JSON.parse(await readFile(join(iconsDir, "Contents.json"), "utf8"));
  const icon = icons.images.find(item => item.size === "1024x1024");
  if (!icon || !/^[A-Za-z0-9_.@-]+\.png$/.test(icon.filename)) throw new Error("Distribution app icon is missing");
  validateAppIcon(await readFile(join(iconsDir, icon.filename)));
  validatePrivacyManifest(await plist(join(editor, "ios/App/App/PrivacyInfo.xcprivacy"), "privacy-source"));
  const capacitor = JSON.parse(await readFile(join(editor, "ios/App/App/capacitor.config.json"), "utf8"));
  if (!["BabylonSlateSecretsPlugin", "BabylonSlateScopedStoragePlugin", "BabylonSlateAudioLifecyclePlugin"].every(name => capacitor.packageClassList?.includes(name))) throw new Error("Custom Capacitor registration is missing; use ios:sync");

  stage = "apple-preflight";
  const api = appleClient();
  const appleApp = await api(`/v1/apps/${process.env.ASC_APP_ID}`);
  if (appleApp.data.attributes.bundleId !== APPLE_BUNDLE_ID) throw new Error("App Store Connect app record differs");
  const groups = await allApplePages(api, `/v1/betaGroups?filter[app]=${process.env.ASC_APP_ID}&limit=200`);
  validatePrivateGroups(groups, { test: process.env.APPLE_TEST_GROUP_ID, release: process.env.APPLE_RELEASE_GROUP_ID });
  const builds = await allApplePages(api, `/v1/builds?filter[app]=${process.env.ASC_APP_ID}&limit=200&sort=-uploadedDate`);
  assertAppleBuildAvailable(identity.appleBuildNumber, builds.map(build => build.attributes.version));

  stage = "archive";
  originalInfo = await readFile(infoPath);
  const sourceInfo = await plist(infoPath, "source-info");
  await run("plutil", [Object.hasOwn(sourceInfo, "ITSAppUsesNonExemptEncryption") ? "-replace" : "-insert", "ITSAppUsesNonExemptEncryption", "-bool", process.env.APPLE_USES_NON_EXEMPT_ENCRYPTION, infoPath], "encryption-declaration");
  const archive = join(privateDir, "App.xcarchive");
  await run("xcodebuild", [...archiveArguments(identity, archive), "-derivedDataPath", join(privateDir, "DerivedData")], "archive");

  stage = "signing";
  const keychain = join(privateDir, "distribution.keychain-db");
  const password = randomBytes(32).toString("hex");
  const certificate = join(privateDir, "distribution.p12");
  const profile = join(privateDir, "distribution.mobileprovision");
  await writeFile(certificate, Buffer.from(process.env.APPLE_DISTRIBUTION_P12_BASE64, "base64"), { mode: 0o600 });
  await writeFile(profile, Buffer.from(process.env.APPLE_PROVISIONING_PROFILE_BASE64, "base64"), { mode: 0o600 });
  const profileXml = await run("security", ["cms", "-D", "-i", profile], "decode-profile");
  const decodedProfile = join(privateDir, "profile.plist");
  await writeFile(decodedProfile, profileXml, { mode: 0o600 });
  const profileInfo = await plist(decodedProfile, "profile-info");
  if (!/^[A-Fa-f0-9-]{36}$/.test(profileInfo.UUID) || profileInfo.TeamIdentifier?.[0] !== process.env.APPLE_TEAM_ID || profileInfo.Entitlements?.["application-identifier"] !== `${process.env.APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}` || profileInfo.Entitlements?.["get-task-allow"] !== false || profileInfo.ProvisionedDevices || profileInfo.ProvisionsAllDevices || new Date(profileInfo.ExpirationDate).getTime() <= Date.now()) throw new Error("App Store provisioning profile is invalid or expired");
  const originalKeychains = (await run("security", ["list-keychains", "-d", "user"], "keychain-list")).match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) ?? [];
  await writeFile(join(privateDir, "original-keychains.json"), JSON.stringify(originalKeychains), { mode: 0o600 });
  await run("security", ["create-keychain", "-p", password, keychain], "create-keychain");
  await run("security", ["set-keychain-settings", "-lut", "21600", keychain], "keychain-settings");
  await run("security", ["unlock-keychain", "-p", password, keychain], "unlock-keychain");
  await run("security", ["import", certificate, "-k", keychain, "-P", process.env.APPLE_DISTRIBUTION_PASSWORD, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], "import-certificate");
  await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain], "keychain-access");
  await run("security", ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains], "select-keychain");
  const signingIdentity = (await run("security", ["find-identity", "-v", "-p", "codesigning", keychain], "signing-identity")).match(/([A-Fa-f0-9]{40}) "Apple Distribution:/)?.[1];
  if (!signingIdentity) throw new Error("No valid Apple Distribution identity");
  const profileDirectories = [join(homedir(), "Library/MobileDevice/Provisioning Profiles"), join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")];
  for (const parent of profileDirectories) {
    await mkdir(parent, { recursive: true });
    const target = join(parent, `${profileInfo.UUID}.mobileprovision`);
    try { await access(target); throw new Error("Provisioning profile already exists on runner"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const parent of profileDirectories) {
    const target = join(parent, `${profileInfo.UUID}.mobileprovision`);
    await writeFile(join(privateDir, "installed-profile-uuid"), profileInfo.UUID, { mode: 0o600 });
    await cp(profile, target);
  }
  const optionsPath = join(privateDir, "ExportOptions.plist");
  await writeFile(optionsPath, JSON.stringify({ ...exportOptions(process.env.APPLE_TEAM_ID, profileInfo.UUID), signingCertificate: signingIdentity }), { mode: 0o600 });
  await run("plutil", ["-convert", "xml1", optionsPath], "export-options");
  stage = "export";
  const exportPath = join(privateDir, "export");
  await run("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exportPath, "-exportOptionsPlist", optionsPath], "export");
  const ipas = (await readdir(exportPath)).filter(name => name.endsWith(".ipa"));
  if (ipas.length !== 1) throw new Error("Expected one exported IPA");
  const ipa = join(exportPath, ipas[0]);
  const extracted = join(privateDir, "exported-app");
  await run("ditto", ["-x", "-k", ipa, extracted], "inspect-export");
  const app = join(extracted, "Payload/App.app");
  const exportedInfo = await plist(join(app, "Info.plist"), "exported-info");
  await run("codesign", ["--verify", "--deep", "--strict", app], "verify-signature");
  const entitlementText = await run("codesign", ["-d", "--entitlements", ":-", app], "read-entitlements");
  const entitlementPath = join(privateDir, "entitlements.plist");
  await writeFile(entitlementPath, entitlementText, { mode: 0o600 });
  validateAppleBundle(identity, exportedInfo, await plist(entitlementPath, "entitlements-json"), process.env.APPLE_TEAM_ID);
  validatePrivacyManifest(await plist(join(app, "PrivacyInfo.xcprivacy"), "privacy-export"));

  stage = "upload";
  const apiKeyPath = join(privateDir, "api-key.json");
  await writeFile(apiKeyPath, JSON.stringify({ key_id: process.env.ASC_KEY_ID, issuer_id: process.env.ASC_ISSUER_ID || null, key: Buffer.from(process.env.ASC_PRIVATE_KEY_P8_BASE64, "base64").toString("utf8"), in_house: false }), { mode: 0o600 });
  await mkdir(join(privateDir, "fastlane"));
  await cp(join(repo, "fastlane/Fastfile"), join(privateDir, "fastlane/Fastfile"));
  await run("bundle", ["exec", "fastlane", "upload"], "upload", privateDir, { ...process.env, BUNDLE_GEMFILE: join(repo, "Gemfile"), ASC_API_KEY_FILE: apiKeyPath, APPLE_IPA_PATH: ipa, TMPDIR: privateDir, FASTLANE_SKIP_UPDATE_CHECK: "true", FASTLANE_OPT_OUT_USAGE: "true", FASTLANE_SKIP_DOCS: "true" });
  uploaded = true;
  await appendFile(process.env.GITHUB_OUTPUT, "uploaded=true\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\niPadOS ${identity.appleMarketingVersion} / ${identity.appleBuildNumber}: **uploaded**. Tester availability is not yet established.\n`);
} catch (error) {
  if (["configuration", "asset-and-privacy-validation", "apple-preflight"].includes(stage) && error instanceof Error && !error.message.includes("ENOENT")) console.error(error.message);
  else console.error(`Apple ${stage} failed. ${uploaded ? "Upload completed; preserve its identity." : "Check App Store Connect before retrying an uncertain upload."} Private diagnostics were not published.`);
  process.exitCode = 1;
} finally {
  if (originalInfo) await writeFile(infoPath, originalInfo);
  try { await cleanupApple(); } catch { console.error("Apple cleanup failed; inspect the ephemeral runner privately"); process.exitCode = 1; }
}
