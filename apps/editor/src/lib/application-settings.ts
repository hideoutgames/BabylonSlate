/** Launcher-owned application preferences, separate from engine settings. */
export type ApplicationSettings = {
  autoUpdate: boolean;
};

const STORAGE_KEY = "slate:application-settings";

export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  autoUpdate: true,
};

export function readApplicationSettings(): ApplicationSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const stored =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Partial<Record<keyof ApplicationSettings, unknown>>)
        : {};
    return {
      autoUpdate:
        typeof stored.autoUpdate === "boolean"
          ? stored.autoUpdate
          : DEFAULT_APPLICATION_SETTINGS.autoUpdate,
    };
  } catch {
    return { ...DEFAULT_APPLICATION_SETTINGS };
  }
}

export function writeApplicationSettings(settings: ApplicationSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Optional preference. */
  }
}
