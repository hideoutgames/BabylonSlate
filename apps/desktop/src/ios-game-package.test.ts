import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSettingArguments } from "../../../packages/exporter/src/native-ios";
import { findXcode, packageIosGame, xcodeFailure, type IosGamePackageRequest } from "./ios-game-package";
import type { RunCommand } from "./mac-game-package";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

/** The template trimmed to what packaging touches. */
async function template(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haptic-ios-template-"));
  cleanup.push(root);
  await mkdir(join(root, "HapticGame.xcodeproj"), { recursive: true });
  await mkdir(join(root, "HapticGame", "Assets.xcassets"), { recursive: true });
  await writeFile(join(root, "HapticGame.xcodeproj", "project.pbxproj"), "project");
  await writeFile(join(root, "HapticGame", "HapticGameApp.swift"), "app");
  return root;
}

function request(overrides: Partial<IosGamePackageRequest> = {}): IosGamePackageRequest {
  return {
    game: [["index.html", new TextEncoder().encode("<html>")]],
    name: "Space Game", appId: "com.studio.space", version: "1.2.0", buildNumber: 7, format: "app-store",
    icon: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), teamId: "ABCDE12345",
    ...overrides,
  };
}

/** Xcode, recorded: archive notes what the project held, export writes an IPA and keeps its options. */
function xcode(options: { version?: string; fail?: "archive" | "export" | "sdk" } = {}) {
  const calls: string[][] = [];
  const seen: Record<string, string | boolean> = {};
  const run: RunCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "-version") {
      if (options.version === undefined) return { stdout: "Xcode 26.6\nBuild version 17F113\n", stderr: "" };
      if (options.version === "") throw new Error("xcode-select: error: tool 'xcodebuild' requires Xcode");
      return { stdout: `Xcode ${options.version}\n`, stderr: "" };
    }
    if (command.endsWith("xcrun")) {
      if (options.fail === "sdk") throw new Error("SDK \"iphoneos\" cannot be located");
      return { stdout: "26.5\n", stderr: "" };
    }
    if (args.includes("archive")) {
      if (options.fail === "archive") throw new Error("note: Using codesigning identity\n/path/HapticGame.xcodeproj: error: No Account for Team \"ABCDE12345\". (in target 'HapticGame')\n** ARCHIVE FAILED **");
      const project = args[args.indexOf("-project") + 1]!.replace(/\/HapticGame\.xcodeproj$/, "");
      seen.game = await readFile(join(project, "HapticGame", "game", "index.html"), "utf8");
      seen.template = await readFile(join(project, "HapticGame", "HapticGameApp.swift"), "utf8");
      seen.icon = await access(join(project, "HapticGame", "Assets.xcassets", "AppIcon.appiconset", "AppIcon.png")).then(() => true, () => false);
      return { stdout: "** ARCHIVE SUCCEEDED **", stderr: "" };
    }
    if (args[0] === "-exportArchive") {
      if (options.fail === "export") throw new Error("error: exportArchive: No signing certificate \"iOS Distribution\" found");
      seen.exportOptions = await readFile(args[args.indexOf("-exportOptionsPlist") + 1]!, "utf8");
      const exported = args[args.indexOf("-exportPath") + 1]!;
      await mkdir(exported, { recursive: true });
      await writeFile(join(exported, "HapticGame.ipa"), "ipa");
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls, seen };
}

describe("iOS game packages", () => {
  it("archive with Xcode's automatic signing for the team, then export an App Store IPA", async () => {
    const tools = xcode();
    const result = await packageIosGame({ request: request(), templateRoot: await template(), run: tools.run });

    expect(result).toEqual({ fileName: "Space_Game-iOS.ipa", bytes: new TextEncoder().encode("ipa") });
    const archive = tools.calls.find((call) => call.includes("archive"))!;
    expect(archive[0]).toBe("/usr/bin/xcodebuild");
    expect(archive.slice(1, 9)).toEqual(["-project", expect.stringMatching(/project\/HapticGame\.xcodeproj$/), "-scheme", "HapticGame",
      "-configuration", "Release", "-destination", "generic/platform=iOS"]);
    expect(archive).toContain("-allowProvisioningUpdates");
    expect(archive.slice(archive.indexOf("archive") + 1)).toEqual(buildSettingArguments({
      PRODUCT_BUNDLE_IDENTIFIER: "com.studio.space", MARKETING_VERSION: "1.2.0", CURRENT_PROJECT_VERSION: "7",
      INFOPLIST_KEY_CFBundleDisplayName: "Space Game", DEVELOPMENT_TEAM: "ABCDE12345", ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
    }));
    // Xcode built the template with the game and its icon in it.
    expect(tools.seen).toMatchObject({ game: "<html>", template: "app", icon: true });
    expect(tools.seen.exportOptions).toContain("<string>app-store-connect</string>");
    expect(tools.calls.at(-1)!.slice(0, 2)).toEqual(["/usr/bin/xcodebuild", "-exportArchive"]);
    expect(tools.calls.at(-1)).toContain("-allowProvisioningUpdates");
  });

  it("export a development IPA without an App Icon, and require one for the App Store", async () => {
    const tools = xcode();
    const result = await packageIosGame({ request: request({ format: "development", icon: null }), templateRoot: await template(), run: tools.run });
    expect(result.fileName).toBe("Space_Game-iOS-Development.ipa");
    expect(tools.seen.exportOptions).toContain("<string>debugging</string>");
    expect(tools.calls.find((call) => call.includes("archive"))!.some((arg) => arg.startsWith("ASSETCATALOG_COMPILER_APPICON_NAME"))).toBe(false);

    const refused = xcode();
    await expect(packageIosGame({ request: request({ icon: null }), templateRoot: await template(), run: refused.run }))
      .rejects.toThrow("The App Store needs an app icon. Set the App Icon in Project Settings > Export.");
    expect(refused.calls).toEqual([]);
  });

  it("report Xcode's errors when it cannot build or sign, and refuse an identity Apple would", async () => {
    await expect(packageIosGame({ request: request(), templateRoot: await template(), run: xcode({ fail: "archive" }).run }))
      .rejects.toThrow("Xcode could not build the game: /path/HapticGame.xcodeproj: error: No Account for Team \"ABCDE12345\". (in target 'HapticGame')");
    await expect(packageIosGame({ request: request(), templateRoot: await template(), run: xcode({ fail: "export" }).run }))
      .rejects.toThrow("Xcode could not sign the game: error: exportArchive: No signing certificate \"iOS Distribution\" found");
    const invalid = xcode();
    await expect(packageIosGame({ request: request({ version: "1.0 beta" }), templateRoot: await template(), run: invalid.run }))
      .rejects.toThrow("iOS needs a version of up to three numbers");
    expect(invalid.calls).toEqual([]);
  });
});

describe("Xcode", () => {
  it("accept Xcode 16 and later with the iOS platform, and say what to install otherwise", async () => {
    expect(await findXcode(xcode().run)).toEqual({ version: "26.6", problems: [] });
    expect(await findXcode(xcode({ version: "" }).run)).toEqual({ version: null, problems: ["Install Xcode from the App Store and open it once to finish setting it up."] });
    expect(await findXcode(xcode({ version: "15.4" }).run)).toEqual({ version: "15.4", problems: ["Xcode 15.4 is too old; iOS games need Xcode 16 or later."] });
    expect(await findXcode(xcode({ fail: "sdk" }).run)).toEqual({ version: "26.6", problems: ["Add the iOS platform in Xcode > Settings > Components."] });
  });

  it("keep only the error lines of xcodebuild's output", () => {
    expect(xcodeFailure("line\nerror: one\nmore\nerror: one\nerror: two")).toBe("error: one error: two");
    expect(xcodeFailure("a\nb")).toBe("a b");
  });
});
