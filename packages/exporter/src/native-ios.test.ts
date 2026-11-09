import { describe, expect, it } from "vitest";
import { strFromU8, strToU8 } from "fflate";
import { buildSettingArguments, iosBuildSettings, iosExportOptions, iosGameFileName, iosProjectFiles, isValidTeamId, type IosBuildInput } from "./native-ios";

function build(overrides: Partial<IosBuildInput> = {}): IosBuildInput {
  return { name: "Space Game", appId: "com.studio.space", version: "1.2.0", buildNumber: 7, teamId: "ABCDE12345", hasIcon: true, ...overrides };
}

describe("iOS project files", () => {
  it("put the game in the app's game folder and the App Icon in its asset catalog", () => {
    const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const files = iosProjectFiles({ game: [["index.html", strToU8("<html>")], ["assets/data-1.bin", new Uint8Array([7])]], icon });
    expect(files.map(([path]) => path)).toEqual([
      "HapticGame/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "HapticGame/Assets.xcassets/AppIcon.appiconset/AppIcon.png",
      "HapticGame/game/assets/data-1.bin",
      "HapticGame/game/index.html",
    ]);
    expect(JSON.parse(strFromU8(files[0]![1]))).toEqual({
      images: [{ filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    });
    expect(files[1]![1]).toBe(icon);
    expect(iosProjectFiles({ game: [["index.html", strToU8("<html>")]], icon: null }).map(([path]) => path)).toEqual(["HapticGame/game/index.html"]);
    expect(() => iosProjectFiles({ game: [["../escape.js", strToU8("x")]], icon: null })).toThrow("Invalid game file path: ../escape.js");
  });

  it("give xcodebuild the game's identity and the team as build settings, naming the icon set only when there is one", () => {
    expect(iosBuildSettings(build())).toEqual({
      PRODUCT_BUNDLE_IDENTIFIER: "com.studio.space",
      MARKETING_VERSION: "1.2.0",
      CURRENT_PROJECT_VERSION: "7",
      INFOPLIST_KEY_CFBundleDisplayName: "Space Game",
      DEVELOPMENT_TEAM: "ABCDE12345",
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
    });
    expect(iosBuildSettings(build({ hasIcon: false, name: "  " }))).toEqual({
      PRODUCT_BUNDLE_IDENTIFIER: "com.studio.space", MARKETING_VERSION: "1.2.0", CURRENT_PROJECT_VERSION: "7",
      INFOPLIST_KEY_CFBundleDisplayName: "Game", DEVELOPMENT_TEAM: "ABCDE12345",
    });
    // Spaces stay inside one argument: xcodebuild runs without a shell.
    expect(buildSettingArguments({ MARKETING_VERSION: "1.2.0", INFOPLIST_KEY_CFBundleDisplayName: "Space Game" }))
      .toEqual(["MARKETING_VERSION=1.2.0", "INFOPLIST_KEY_CFBundleDisplayName=Space Game"]);
  });

  it("refuse what the App Store or xcodebuild would", () => {
    expect(() => iosBuildSettings(build({ version: "1.2.0-beta" }))).toThrow('iOS needs a version of up to three numbers, such as 1.2.3, not "1.2.0-beta". Set it in Project Settings > General.');
    expect(() => iosBuildSettings(build({ version: "1.2.3.4" }))).toThrow("iOS needs a version of up to three numbers");
    expect(() => iosBuildSettings(build({ appId: "com.my-studio.game" }))).toThrow("App ID com.my-studio.game is not valid.");
    expect(() => iosBuildSettings(build({ buildNumber: 0 }))).toThrow("Build Number 0 is not valid.");
    expect(() => iosBuildSettings(build({ teamId: "" }))).toThrow("Enter your Apple Team ID in Engine Settings > Packaging.");
    expect(() => iosBuildSettings(build({ name: "Cost $(HOME)" }))).toThrow("The Display Name cannot contain $( or line breaks on iOS.");
    expect([isValidTeamId("ABCDE12345"), isValidTeamId("abcde12345"), isValidTeamId("ABCDE1234")]).toEqual([true, false, false]);
  });

  it("export with Xcode's automatic signing for the team, keeping the project's version on App Store uploads", () => {
    const appStore = iosExportOptions("app-store", "ABCDE12345");
    expect(appStore).toContain("<key>method</key><string>app-store-connect</string>");
    expect(appStore).toContain("<key>signingStyle</key><string>automatic</string>");
    expect(appStore).toContain("<key>teamID</key><string>ABCDE12345</string>");
    expect(appStore).toContain("<key>manageAppVersionAndBuildNumber</key><false/>");
    const development = iosExportOptions("development", "ABCDE12345");
    expect(development).toContain("<key>method</key><string>debugging</string>");
    expect(development).not.toContain("manageAppVersionAndBuildNumber");
  });

  it("name the IPA like the other packages, marking development builds", () => {
    expect(iosGameFileName("Space Game", "app-store")).toBe("Space_Game-iOS.ipa");
    expect(iosGameFileName("Rocket: Run?", "development")).toBe("Rocket_Run-iOS-Development.ipa");
  });
});
