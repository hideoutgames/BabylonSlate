import { TEXTURE_BYTE_CEILING } from "./perf-ceilings";

type DeviceNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;

const MIB = 1024 * 1024;

/** What a device class allows at most, whatever the project or quality level asks for. */
interface DeviceProfile {
  /** A phone or tablet (`isMobileGpuDevice`). */
  mobile: boolean;
  /**
   * Texture cache ceiling: a quality level's, the Engine Settings' or a view's larger budget is lowered to it. With
   * the texture budget turned off in Engine Settings nothing is evicted, here too: that is the user's choice.
   */
  textureByteCeiling: number;
  /** The shadow atlas edge ceiling in texels (`shadowAtlasEdge`), or null for none. */
  shadowAtlasCap: number | null;
}

/** Desktops and laptops. */
const DESKTOP: DeviceProfile = {
  mobile: false,
  textureByteCeiling: TEXTURE_BYTE_CEILING,
  shadowAtlasCap: null,
};

/**
 * Phones and tablets: the desktop's shadow map sizes and light limits (`HAPTIC_LIGHT_MAXIMUM`), so the quality level
 * alone sizes their shadows and lights. Only textures stay lower: WKWebView kills a page past its memory limit, and the texture cache is the
 * largest share a scene holds. For the same reason the shadow atlas stops at 8192, every quality level's own edge:
 * a Custom 8192 Directional Map Size's 16384 atlas (1 GiB) falls back to 4096 maps there.
 */
const MOBILE: DeviceProfile = {
  ...DESKTOP,
  mobile: true,
  textureByteCeiling: 768 * MIB,
  shadowAtlasCap: 8192,
};

/**
 * Phones and tablets, in a browser, the iOS or Android app or an exported game. iPadOS Safari and WKWebView report
 * a Mac user agent, so a Mac that takes touch counts as an iPad.
 */
export function isMobileGpuDevice(nav: DeviceNavigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const agent = nav.userAgent ?? "";
  return /iPhone|iPad|iPod|Android/i.test(agent) || (/Macintosh/.test(agent) && (nav.maxTouchPoints ?? 0) > 1);
}

/** This device's profile; the one place render code tells device classes apart. */
export function deviceProfile(nav?: DeviceNavigator): DeviceProfile {
  return isMobileGpuDevice(nav) ? MOBILE : DESKTOP;
}

/** The limit a texture budget of `requested` bytes meets on this device, for `qualityLimits`. */
export function deviceTextureLimits(requested: number, nav?: DeviceNavigator): string[] {
  const ceiling = deviceProfile(nav).textureByteCeiling;
  return requested > ceiling ? [`textures: at most ${Math.round(ceiling / MIB)} MiB on this device class`] : [];
}
