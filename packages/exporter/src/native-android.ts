import { isValidAppId } from "@haptic/core/app-identity";
import { appIconPng, type AppIconImages } from "./app-icon";
import { desktopGameNames } from "./native-desktop";

/**
 * Android game packages: what Haptic writes into its Android project template
 * (`apps/desktop/android-game`) before the desktop app builds it with Gradle.
 * The template's GameActivity serves `app/src/main/assets/game` in a WebView;
 * `app/haptic-game.properties` gives Gradle the app's identity, a string
 * resource its name, and the App Icon becomes the launcher mipmaps.
 */

/** APK: installed directly. AAB (Android App Bundle): uploaded to Google Play. */
export type AndroidPackageFormat = "apk" | "aab";

/**
 * Where the desktop app keeps the keystore's passwords in this computer's
 * secret store: Engine Settings writes them, packaging reads them, and they
 * never travel with a packaging request.
 */
export const ANDROID_SIGNING_SECRETS = {
  store: "android-signing:store-password",
  key: "android-signing:key-password",
} as const;

/** The largest version code Google Play accepts. */
export const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

/** Android screen densities and their scale from 1 dp to pixels. */
const DENSITIES: readonly [string, number][] = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];
/** The legacy launcher icon is 48 dp; an adaptive icon shows its 72 dp centre. */
const LAUNCHER_DP = 48;
const ADAPTIVE_VISIBLE_DP = 72;

/** Every App Icon edge an Android package uses, in pixels. */
export const ANDROID_ICON_SIZES: readonly number[] = [...new Set(DENSITIES.flatMap(([, scale]) => [LAUNCHER_DP * scale, ADAPTIVE_VISIBLE_DP * scale]))]
  .sort((a, b) => a - b);

/**
 * Android 8 and later mask launcher icons to the device's shape: the App Icon
 * fills the 72 dp the mask shows, inset in the 108 dp layer, over white that
 * shows only where the icon is transparent or during launcher animations.
 */
const ADAPTIVE_ICON = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/white" />
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_image" android:inset="16.667%" />
    </foreground>
</adaptive-icon>
`;

export interface AndroidProjectInput {
  /** The exported web game, served from `assets/game`. */
  game: Iterable<[string, Uint8Array]>;
  /** The app's name on the launcher. */
  name: string;
  appId: string;
  /** The project version: Android's version name. */
  version: string;
  /** Android's version code. */
  buildNumber: number;
  icon?: AppIconImages | null;
}

/** The saved package's name, like the desktop packages' (`Space_Game-Android.apk`). */
export function androidGameFileName(displayName: string, format: AndroidPackageFormat): string {
  return `${desktopGameNames(displayName, "windows-x64").folder.replace(/\s+/g, "_")}-Android.${format}`;
}

/** A Java properties value, read back as UTF-8. */
function propertyValue(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
    .replace(/[=:#!]/g, (character) => `\\${character}`)
    .replace(/^ /, "\\ ");
}

/** An Android string resource's text: XML escaped, with the characters Android's resource compiler treats specially escaped. */
export function androidStringResource(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/^([@?])/, "\\$1");
}

/**
 * The files the template takes for one package, relative to its root, in
 * order: identity, name, launcher icons (with an App Icon), then the game.
 */
export function androidProjectFiles(input: AndroidProjectInput): [string, Uint8Array][] {
  if (!isValidAppId(input.appId)) throw new Error(`App ID ${input.appId} is not valid. Set it in Project Settings > Export.`);
  if (!Number.isSafeInteger(input.buildNumber) || input.buildNumber < 1 || input.buildNumber > MAX_ANDROID_VERSION_CODE) {
    throw new Error(`Build Number ${input.buildNumber} is not valid on Android: use 1 to ${MAX_ANDROID_VERSION_CODE}. Set it in Project Settings > Export.`);
  }
  const encoder = new TextEncoder();
  const properties = {
    applicationId: input.appId,
    versionCode: String(input.buildNumber),
    versionName: input.version.trim() || "0",
    hasIcon: String(Boolean(input.icon)),
  };
  const files: [string, Uint8Array][] = [
    ["app/haptic-game.properties", encoder.encode(Object.entries(properties).map(([key, value]) => `${key}=${propertyValue(value)}\n`).join(""))],
    ["app/src/main/res/values/haptic_game.xml", encoder.encode(
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${androidStringResource(input.name.trim() || "Game")}</string>\n</resources>\n`)],
  ];
  if (input.icon) {
    for (const [density, scale] of DENSITIES) {
      files.push([`app/src/main/res/mipmap-${density}/ic_launcher.png`, appIconPng(input.icon, LAUNCHER_DP * scale)]);
      files.push([`app/src/main/res/mipmap-${density}/ic_launcher_image.png`, appIconPng(input.icon, ADAPTIVE_VISIBLE_DP * scale)]);
    }
    files.push(["app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", encoder.encode(ADAPTIVE_ICON)]);
  }
  for (const [path, data] of [...input.game].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Invalid game file path: ${path}`);
    }
    files.push([`app/src/main/assets/game/${path}`, data]);
  }
  return files;
}
