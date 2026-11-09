import { isValidAppId } from "@haptic/core/app-identity";
import { desktopGameNames } from "./native-desktop";

/**
 * iOS game packages: what Haptic writes into its Xcode project template
 * (`apps/desktop/ios-game`) and passes to xcodebuild before the desktop app
 * on a Mac builds, signs and exports it. The template is static and holds no
 * identity: the game's bundle ID, version, name and the user's team reach the
 * build as build settings, so nothing in the repository names a team.
 */

/** App Store: an IPA for TestFlight and the App Store. Development: an IPA for the team's registered devices. */
export type IosPackageFormat = "app-store" | "development";

/** Where the template's target takes the game and its asset catalog. */
const APP_FOLDER = "HapticGame";

export interface IosProjectInput {
  /** The exported web game, served from the app's `game` folder. */
  game: Iterable<[string, Uint8Array]>;
  /** The App Icon as an opaque 1024 px PNG (`encodeOpaquePng`), or null for none. */
  icon: Uint8Array | null;
}

export interface IosBuildInput {
  /** The name under the icon. */
  name: string;
  appId: string;
  /** The project version: the app's marketing version. */
  version: string;
  buildNumber: number;
  /** The user's Apple Developer team. */
  teamId: string;
  hasIcon: boolean;
}

/** Apple's team identifiers: ten capital letters and digits. */
export function isValidTeamId(teamId: string): boolean {
  return /^[A-Z0-9]{10}$/.test(teamId);
}

/** The saved package's name, like the other packages' (`Space_Game-iOS.ipa`). */
export function iosGameFileName(displayName: string, format: IosPackageFormat): string {
  const stem = desktopGameNames(displayName, "windows-x64").folder.replace(/\s+/g, "_");
  return `${stem}-iOS${format === "development" ? "-Development" : ""}.ipa`;
}

/** The files the template takes for one package, relative to its root: the App Icon set, then the game. */
export function iosProjectFiles(input: IosProjectInput): [string, Uint8Array][] {
  const encoder = new TextEncoder();
  const files: [string, Uint8Array][] = [];
  if (input.icon) {
    // One 1024 px image: Xcode makes every size from it.
    files.push([`${APP_FOLDER}/Assets.xcassets/AppIcon.appiconset/Contents.json`, encoder.encode(`${JSON.stringify({
      images: [{ filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    }, null, 2)}\n`)]);
    files.push([`${APP_FOLDER}/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, input.icon]);
  }
  for (const [path, data] of [...input.game].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Invalid game file path: ${path}`);
    }
    files.push([`${APP_FOLDER}/game/${path}`, data]);
  }
  return files;
}

/**
 * Build settings for xcodebuild's command line (each passed as `NAME=value`),
 * checked first: the App Store takes versions of up to three numbers, and a
 * build setting value expands `$(…)`, so the name may not contain it.
 */
export function iosBuildSettings(input: IosBuildInput): Record<string, string> {
  if (!isValidAppId(input.appId)) throw new Error(`App ID ${input.appId} is not valid. Set it in Project Settings > Export.`);
  const version = input.version.trim();
  if (!/^\d+(\.\d+){0,2}$/.test(version)) {
    throw new Error(`iOS needs a version of up to three numbers, such as 1.2.3, not "${version}". Set it in Project Settings > General.`);
  }
  if (!Number.isSafeInteger(input.buildNumber) || input.buildNumber < 1) {
    throw new Error(`Build Number ${input.buildNumber} is not valid. Set it in Project Settings > Export.`);
  }
  if (!isValidTeamId(input.teamId)) throw new Error("Enter your Apple Team ID in Engine Settings > Packaging.");
  const name = input.name.trim() || "Game";
  if (name.includes("$(") || /[\r\n]/.test(name)) throw new Error("The Display Name cannot contain $( or line breaks on iOS. Change it in Project Settings > Export.");
  return {
    PRODUCT_BUNDLE_IDENTIFIER: input.appId,
    MARKETING_VERSION: version,
    CURRENT_PROJECT_VERSION: String(input.buildNumber),
    INFOPLIST_KEY_CFBundleDisplayName: name,
    DEVELOPMENT_TEAM: input.teamId,
    ...(input.hasIcon ? { ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon" } : {}),
  };
}

/** Build settings as xcodebuild's `NAME=value` arguments. */
export function buildSettingArguments(settings: Record<string, string>): string[] {
  return Object.entries(settings).map(([name, value]) => `${name}=${value}`);
}

/** xcodebuild -exportArchive's options: Xcode's automatic signing for the team, App Store or development. */
export function iosExportOptions(format: IosPackageFormat, teamId: string): string {
  const entries: [string, string][] = [
    ["method", format === "app-store" ? "<string>app-store-connect</string>" : "<string>debugging</string>"],
    ["signingStyle", "<string>automatic</string>"],
    ["teamID", `<string>${teamId}</string>`],
    ["destination", "<string>export</string>"],
    // The project's version and Build Number are the ones uploaded.
    ...(format === "app-store" ? [["manageAppVersionAndBuildNumber", "<false/>"] as [string, string]] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([key, value]) => `  <key>${key}</key>${value}`).join("\n")}
</dict>
</plist>
`;
}
