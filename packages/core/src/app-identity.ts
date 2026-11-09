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
  /**
   * Texture asset whose source image becomes the app icon of every package;
   * null keeps each platform's default. Packaging requires a square image of
   * at least `APP_ICON_MIN_SIZE` pixels.
   */
  iconTextureGuid: string | null;
}

export const DEFAULT_APP_IDENTITY: AppIdentity = { appId: "", displayName: "", buildNumber: 1, iconTextureGuid: null };

/** The smallest App Icon source edge: the largest icon a package holds (macOS 512 pt at 2x, the iOS App Store icon). */
export const APP_ICON_MIN_SIZE = 1024;

/** Why an App Icon source of this size cannot be packaged, or null when it can. */
export function appIconSizeProblem(size: { width: number; height: number }): string | null {
  if (size.width !== size.height) return `The App Icon must be square; this image is ${size.width} × ${size.height}.`;
  if (size.width < APP_ICON_MIN_SIZE) {
    return `The App Icon must be at least ${APP_ICON_MIN_SIZE} × ${APP_ICON_MIN_SIZE}; this image is ${size.width} × ${size.height}.`;
  }
  return null;
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
    iconTextureGuid: typeof raw.iconTextureGuid === "string" && raw.iconTextureGuid.trim() ? raw.iconTextureGuid.trim() : null,
  };
}

/** The identity a package uses: blanks filled from the project. */
export function resolvedAppIdentity(identity: AppIdentity, projectName: string): AppIdentity {
  return {
    appId: identity.appId || defaultAppId(projectName),
    displayName: identity.displayName || projectName.trim() || "Game",
    buildNumber: identity.buildNumber,
    iconTextureGuid: identity.iconTextureGuid,
  };
}
