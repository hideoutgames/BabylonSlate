/**
 * How a native app package identifies the game: macOS now, Android and iOS
 * later. The version is the project's (`ProjectMetadata.version`).
 */
export interface AppIdentity {
  /** Reverse-DNS app ID (`com.studio.game`); empty uses `defaultAppId`. */
  appId: string;
  /** Name under the app's icon; empty uses the project name. */
  displayName: string;
  /** Increases with every store upload; a positive integer. */
  buildNumber: number;
}

export const DEFAULT_APP_IDENTITY: AppIdentity = { appId: "", displayName: "", buildNumber: 1 };

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
  };
}

/** The identity a package uses: blanks filled from the project. */
export function resolvedAppIdentity(identity: AppIdentity, projectName: string): AppIdentity {
  return {
    appId: identity.appId || defaultAppId(projectName),
    displayName: identity.displayName || projectName.trim() || "Game",
    buildNumber: identity.buildNumber,
  };
}
