import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "no.hideout.babylonslate",
  appName: "BabylonSlate",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "always",
    // Capacitor copies editor `dist/` (including `/havok`, `/ktx2`,
    // `coi-serviceworker.js`, and `/player/`) into the iOS public folder.
    // WKWebView needs a first-gesture audio unlock (Play overlay + player).
    // Local Keychain plugin: keep `BabylonSlateSecretsPlugin` in
    // ios/App/App/capacitor.config.json `packageClassList` after `npx cap sync`.
  },
};

export default config;
