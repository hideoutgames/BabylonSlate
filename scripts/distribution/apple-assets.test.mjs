import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateAppIcon, validatePrivacyManifest } from "./apple-assets.mjs";

test("distribution accepts the shipped app icon and rejects the Capacitor placeholder and undersized or transparent icons", async () => {
  const shipped = await readFile("apps/editor/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
  assert.doesNotThrow(() => validateAppIcon(shipped));
  const placeholder = await readFile("scripts/distribution/fixtures/capacitor-placeholder-app-icon.png");
  assert.throws(() => validateAppIcon(placeholder), /icon/i);
  const small = await readFile("engine-logos/HapticMark-DarkMode.png");
  assert.throws(() => validateAppIcon(small), /icon/i);
});

test("privacy validation requires reasons for native bookmarks and user-selected project timestamps", () => {
  const privacy = { NSPrivacyTracking: false, NSPrivacyTrackingDomains: [], NSPrivacyCollectedDataTypes: [], NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
    { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1", "3B52.1"] },
  ] };
  assert.doesNotThrow(() => validatePrivacyManifest(privacy));
  assert.throws(() => validatePrivacyManifest({ ...privacy, NSPrivacyAccessedAPITypes: [] }), /privacy/i);
});
