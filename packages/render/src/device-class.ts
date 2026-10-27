import { MOBILE_SHADOW_MAP_CAP, type ShadowMapSizeCap } from "@haptic/core";

type DeviceNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;

/**
 * Phones and tablets, in a browser, the iOS or Android app or an exported game. iPadOS Safari and WKWebView report
 * a Mac user agent, so a Mac that takes touch counts as an iPad.
 */
export function isMobileGpuDevice(nav: DeviceNavigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const agent = nav.userAgent ?? "";
  return /iPhone|iPad|iPod|Android/i.test(agent) || (/Macintosh/.test(agent) && (nav.maxTouchPoints ?? 0) > 1);
}

/** The shadow map edge ceiling this device class allocates at most, or null for none. */
export function deviceShadowMapCap(nav?: DeviceNavigator): ShadowMapSizeCap | null {
  return isMobileGpuDevice(nav) ? MOBILE_SHADOW_MAP_CAP : null;
}
