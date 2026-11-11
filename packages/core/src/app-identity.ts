/**
 * How a packaged game identifies itself: its desktop and web packages now,
 * Android and iOS later. The version is the project's (`ProjectMetadata.version`).
 */
export interface AppIdentity {
  /** Reverse-DNS app ID (`com.studio.game`); empty uses `defaultAppId`. */
  appId: string;
  /** Name under the app's icon; empty uses the project name. */
  displayName: string;
  /** Increases with every store upload; a positive integer. */
  buildNumber: number;
  /** Adds 1 to `buildNumber` after every package, whatever the platform (`advanceBuildNumber`). */
  autoIncrementBuildNumber: boolean;
  /**
   * Texture asset whose source image becomes the app icon of every package;
   * null keeps each platform's default. Any size works: packaging cuts the
   * centre square (`appIconCrop`) and scales it to every icon size.
   */
  iconTextureGuid: string | null;
}

export const DEFAULT_APP_IDENTITY: AppIdentity = { appId: "", displayName: "", buildNumber: 1, autoIncrementBuildNumber: false, iconTextureGuid: null };

/** The largest icon a package holds (macOS 512 pt at 2x, the iOS App Store icon); smaller sources are scaled up. */
export const APP_ICON_SHARP_SIZE = 1024;

/** The square of an App Icon source that becomes the icon: the centre, as large as the shorter side. */
export function appIconCrop(size: { width: number; height: number }): { x: number; y: number; edge: number } {
  const edge = Math.min(size.width, size.height);
  return { x: Math.floor((size.width - edge) / 2), y: Math.floor((size.height - edge) / 2), edge };
}

/** A note when an App Icon source is cropped or scaled up, or null when it is used as it is. Never blocks packaging. */
export function appIconSizeHint(size: { width: number; height: number }): string | null {
  const { edge } = appIconCrop(size);
  const notes = [
    size.width !== size.height ? `The centre ${edge} × ${edge} is used.` : null,
    edge < APP_ICON_SHARP_SIZE ? `Icons up to ${APP_ICON_SHARP_SIZE} × ${APP_ICON_SHARP_SIZE} are scaled up and may look soft.` : null,
  ].filter(Boolean);
  return notes.length > 0 ? `This image is ${size.width} × ${size.height}. ${notes.join(" ")}` : null;
}

/**
 * Segments of letters and digits starting with a letter, at least two: the
 * form Apple bundle IDs and Android package names both accept (Apple refuses
 * underscores, Android hyphens).
 */
const APP_ID = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

export function isValidAppId(value: string): boolean {
  return value.length <= 155 && APP_ID.test(value);
}

/** `com.example.<project>`: valid everywhere, and obviously a placeholder. */
export function defaultAppId(projectName: string): string {
  const name = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^[0-9]+/, "");
  return `com.example.${name || "game"}`;
}

export function normalizeAppIdentity(value: unknown): AppIdentity {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const appId = typeof raw.appId === "string" ? raw.appId.trim() : "";
  return {
    appId: isValidAppId(appId) ? appId : "",
    displayName: typeof raw.displayName === "string" ? raw.displayName.trim().slice(0, 100) : "",
    buildNumber: typeof raw.buildNumber === "number" && Number.isSafeInteger(raw.buildNumber) && raw.buildNumber >= 1
      ? raw.buildNumber
      : DEFAULT_APP_IDENTITY.buildNumber,
    autoIncrementBuildNumber: raw.autoIncrementBuildNumber === true,
    iconTextureGuid: typeof raw.iconTextureGuid === "string" && raw.iconTextureGuid.trim() ? raw.iconTextureGuid.trim() : null,
  };
}

/** The identity a package uses: blanks filled from the project. */
export function resolvedAppIdentity(identity: AppIdentity, projectName: string): AppIdentity {
  return {
    appId: identity.appId || defaultAppId(projectName),
    displayName: identity.displayName || projectName.trim() || "Game",
    buildNumber: identity.buildNumber,
    autoIncrementBuildNumber: identity.autoIncrementBuildNumber,
    iconTextureGuid: identity.iconTextureGuid,
  };
}

/**
 * The identity after a package built with `builtNumber`: with Auto Increment
 * Build Number on, the next package gets one more (never less than the number
 * already set); otherwise it is unchanged. Null when nothing changes.
 */
export function advanceBuildNumber(identity: AppIdentity, builtNumber: number): AppIdentity | null {
  if (!identity.autoIncrementBuildNumber) return null;
  const next = Math.max(identity.buildNumber, builtNumber + 1);
  if (!Number.isSafeInteger(next) || next === identity.buildNumber) return null;
  return { ...identity, buildNumber: next };
}
