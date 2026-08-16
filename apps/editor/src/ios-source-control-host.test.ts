import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const editorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const iosApp = join(editorRoot, "ios/App");

describe("iOS source-control host", () => {
  it("compiles BabylonSlateSecretsPlugin into the App target", () => {
    const pbxproj = readFileSync(
      join(iosApp, "App.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(pbxproj).toContain("BabylonSlateSecretsPlugin.swift in Sources");
    expect(pbxproj).toContain("path = BabylonSlateSecretsPlugin.swift");
  });

  it("registers the Keychain plugin in packageClassList", () => {
    const config = JSON.parse(
      readFileSync(join(iosApp, "App/capacitor.config.json"), "utf8"),
    ) as { packageClassList?: string[] };
    expect(config.packageClassList).toContain("BabylonSlateSecretsPlugin");
  });

  it("declares a single applicationDidBecomeActive", () => {
    const delegate = readFileSync(join(iosApp, "App/AppDelegate.swift"), "utf8");
    const matches = delegate.match(/func applicationDidBecomeActive\(/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(delegate).toContain("disableWebViewBounce()");
  });
});
