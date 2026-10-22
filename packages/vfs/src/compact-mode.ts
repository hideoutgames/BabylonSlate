import type { EngineSettings } from "./app-settings";
import { isMobilePlatform } from "./platform";

/** iOS, iPadOS or Android, in the native app or a mobile browser. */
export function isMobileOperatingSystem(): boolean {
  if (isMobilePlatform()) return true;
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod/.test(userAgent)) return true;
  // iPadOS Safari reports a Mac; touch support gives it away.
  return /Macintosh/.test(userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Compact Mode is on by default everywhere except iOS and Android. */
export function defaultCompactMode(): boolean {
  return !isMobileOperatingSystem();
}

/** The effective Compact Mode: the stored choice, else the platform default. */
export function resolveCompactMode(settings: Pick<EngineSettings, "compactMode">): boolean {
  return settings.compactMode ?? defaultCompactMode();
}
