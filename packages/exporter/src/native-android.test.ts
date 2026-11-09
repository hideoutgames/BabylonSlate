import { describe, expect, it } from "vitest";
import { strFromU8, strToU8 } from "fflate";
import { ANDROID_ICON_SIZES, androidGameFileName, androidProjectFiles, androidStringResource, type AndroidProjectInput } from "./native-android";
import { appIconImages } from "./test-support/app-icon-images";

function input(overrides: Partial<AndroidProjectInput> = {}): AndroidProjectInput {
  return {
    game: [["index.html", strToU8("<html>")], ["assets/data-1.bin", new Uint8Array([7])]],
    name: "Space Game", appId: "com.studio.space", version: "1.2.0", buildNumber: 7,
    ...overrides,
  };
}

const text = (files: [string, Uint8Array][], path: string) => strFromU8(files.find(([name]) => name === path)![1]);

describe("Android project files", () => {
  it("give Gradle the app's identity, the launcher its name, and the WebView the game", () => {
    const files = androidProjectFiles(input());
    expect(files.map(([path]) => path)).toEqual([
      "app/haptic-game.properties",
      "app/src/main/res/values/haptic_game.xml",
      "app/src/main/assets/game/assets/data-1.bin",
      "app/src/main/assets/game/index.html",
    ]);
    expect(text(files, "app/haptic-game.properties")).toBe("applicationId=com.studio.space\nversionCode=7\nversionName=1.2.0\nhasIcon=false\n");
    expect(text(files, "app/src/main/res/values/haptic_game.xml")).toContain("<string name=\"app_name\">Space Game</string>");
  });

  it("escape the name for Android's resource compiler and the version for Java properties", () => {
    const files = androidProjectFiles(input({ name: "@Rock & 'Roll' <\"2\">", version: " v2 = beta #3\\" }));
    expect(text(files, "app/haptic-game.properties")).toContain("versionName=v2 \\= beta \\#3\\\\\n");
    expect(text(files, "app/src/main/res/values/haptic_game.xml")).toContain("<string name=\"app_name\">\\@Rock &amp; \\'Roll\\' &lt;\\\"2\\\"&gt;</string>");
    expect(androidStringResource("?Quest\nTwo\\")).toBe("\\?Quest\\nTwo\\\\");
    expect(text(androidProjectFiles(input({ name: "  ", version: "" })), "app/src/main/res/values/haptic_game.xml")).toContain(">Game<");
    expect(text(androidProjectFiles(input({ version: "" })), "app/haptic-game.properties")).toContain("versionName=0\n");
  });

  it("make the App Icon the launcher icon at every density, legacy and adaptive", () => {
    const icon = appIconImages();
    const files = androidProjectFiles(input({ icon }));
    const icons = files.filter(([path]) => path.includes("/mipmap-"));
    expect(icons.map(([path, data]) => [path, path.endsWith(".png") ? new DataView(data.buffer, data.byteOffset).getUint32(16) : "xml"])).toEqual([
      ["app/src/main/res/mipmap-mdpi/ic_launcher.png", 48], ["app/src/main/res/mipmap-mdpi/ic_launcher_image.png", 72],
      ["app/src/main/res/mipmap-hdpi/ic_launcher.png", 72], ["app/src/main/res/mipmap-hdpi/ic_launcher_image.png", 108],
      ["app/src/main/res/mipmap-xhdpi/ic_launcher.png", 96], ["app/src/main/res/mipmap-xhdpi/ic_launcher_image.png", 144],
      ["app/src/main/res/mipmap-xxhdpi/ic_launcher.png", 144], ["app/src/main/res/mipmap-xxhdpi/ic_launcher_image.png", 216],
      ["app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", 192], ["app/src/main/res/mipmap-xxxhdpi/ic_launcher_image.png", 288],
      ["app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "xml"],
    ]);
    expect(text(files, "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml")).toContain("<inset android:drawable=\"@mipmap/ic_launcher_image\" android:inset=\"16.667%\" />");
    expect(text(files, "app/haptic-game.properties")).toContain("hasIcon=true\n");
    expect(ANDROID_ICON_SIZES).toEqual([48, 72, 96, 108, 144, 192, 216, 288]);
  });

  it("refuse an invalid App ID or version code and a game path that leaves the game folder", () => {
    expect(() => androidProjectFiles(input({ appId: "com.my-studio.game" }))).toThrow("App ID com.my-studio.game is not valid. Set it in Project Settings > Export.");
    expect(() => androidProjectFiles(input({ buildNumber: 2_100_000_001 }))).toThrow("Build Number 2100000001 is not valid on Android: use 1 to 2100000000.");
    expect(() => androidProjectFiles(input({ buildNumber: 0 }))).toThrow("is not valid on Android");
    expect(() => androidProjectFiles(input({ game: [["../escape.js", strToU8("x")]] }))).toThrow("Invalid game file path: ../escape.js");
  });

  it("name the package like the desktop packages, without characters Windows refuses", () => {
    expect(androidGameFileName("Space Game", "apk")).toBe("Space_Game-Android.apk");
    expect(androidGameFileName("Rocket: Run?", "aab")).toBe("Rocket_Run-Android.aab");
  });
});
