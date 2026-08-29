import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "no.hideout.babylonslate",
  appName: "BabylonSlate",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "never",
    // Capacitor copies editor `dist/` (including `/havok`, `/ktx2`,
    // `coi-serviceworker.js`, and `/player/`) into the iOS public folder.
    // WKWebView needs a first-gesture audio unlock (Play overlay + player).
  },
  // The local Keychain plugin is restored by scripts/ios-sync.mjs after
  // `npx cap sync`, which only discovers package-provided plugins.
};

export default config;
