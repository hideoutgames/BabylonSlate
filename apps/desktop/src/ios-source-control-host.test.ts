import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const iosApp = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../editor/ios/App",
);

describe("iOS source-control host", () => {
  it("compiles BabylonSlateSecretsPlugin into the App target", () => {
    const pbxproj = readFileSync(
      join(iosApp, "App.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(pbxproj).toContain("BabylonSlateSecretsPlugin.swift in Sources");
    expect(pbxproj).toContain("path = BabylonSlateSecretsPlugin.swift");
  });

  it("registers the Keychain plugin from the bridge view controller", () => {
    const mainViewController = readFileSync(
      join(iosApp, "App/MainViewController.swift"),
      "utf8",
    );
    expect(mainViewController).toContain(
      "registerPluginInstance(BabylonSlateSecretsPlugin())",
    );
    expect(mainViewController).toContain(
      "registerPluginInstance(BabylonSlateFolderPlugin())",
    );
    const gitignore = readFileSync(join(iosApp, "../.gitignore"), "utf8");
    expect(gitignore).toContain("App/App/capacitor.config.json");
  });

  it("declares a single applicationDidBecomeActive", () => {
    const delegate = readFileSync(join(iosApp, "App/AppDelegate.swift"), "utf8");
    const matches = delegate.match(/func applicationDidBecomeActive\(/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(delegate).toContain("disableWebViewBounce()");
  });
});
