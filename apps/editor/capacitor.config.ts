import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig & { packageClassList: string[] } = {
  appId: "no.hideout.babylonslate",
  appName: "BabylonSlate",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "always",
    includePlugins: [
      "@capacitor/filesystem",
      "@capacitor/preferences",
      "CapacitorScopedStorage",
    ],
    // Capacitor copies editor `dist/` (including `/havok`, `/ktx2`,
    // `coi-serviceworker.js`, and `/player/`) into the iOS public folder.
    // WKWebView needs a first-gesture audio unlock (Play overlay + player).
  },
  // Local Keychain plugin: keep this class in the generated native config
  // after `npx cap sync`, which only discovers package-provided plugins.
  packageClassList: ["BabylonSlateSecretsPlugin"],
};

export default config;
