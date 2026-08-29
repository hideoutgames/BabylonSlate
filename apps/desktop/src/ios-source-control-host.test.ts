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

  it("restores the Keychain plugin registration after Capacitor sync", () => {
    // The generated capacitor.config.json is not tracked, so ios-sync.mjs is the source of truth.
    const syncScript = readFileSync(
      join(iosApp, "../../scripts/ios-sync.mjs"),
      "utf8",
    );
    const syncIndex = syncScript.indexOf(
      'spawnSync("pnpm", ["exec", "cap", "sync", "ios"]',
    );
    const registrationIndex = syncScript.indexOf(
      'packageClassList.add("BabylonSlateSecretsPlugin")',
    );
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(registrationIndex).toBeGreaterThan(syncIndex);
    expect(syncScript).toContain(
      "config.packageClassList = [...packageClassList]",
    );
  });

  it("declares a single applicationDidBecomeActive", () => {
    const delegate = readFileSync(join(iosApp, "App/AppDelegate.swift"), "utf8");
    const matches = delegate.match(/func applicationDidBecomeActive\(/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(delegate).toContain("disableWebViewBounce()");
  });
});
