import type { EngineSettings } from "./app-settings";
import { isAppleMobileOperatingSystem, isMobilePlatform } from "./platform";

/** iOS, iPadOS or Android, in the native app or a mobile browser. */
export function isMobileOperatingSystem(): boolean {
  if (isMobilePlatform() || isAppleMobileOperatingSystem()) return true;
  return typeof navigator !== "undefined" && /Android/.test(navigator.userAgent ?? "");
}

/** Compact Mode is on by default everywhere except iOS and Android. */
export function defaultCompactMode(): boolean {
  return !isMobileOperatingSystem();
}

/** The effective Compact Mode: the stored choice, else the platform default. */
export function resolveCompactMode(settings: Pick<EngineSettings, "compactMode">): boolean {
  return settings.compactMode ?? defaultCompactMode();
}
