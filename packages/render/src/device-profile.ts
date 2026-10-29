import { MOBILE_SHADOW_MAP_CAP, type ShadowMapSizeCap } from "@haptic/core";
import { TEXTURE_BYTE_CEILING } from "./perf-ceilings";

type DeviceNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;

const MIB = 1024 * 1024;

/** What a device class allows at most, whatever the project or quality level asks for. */
export interface DeviceProfile {
  /** A phone or tablet (`isMobileGpuDevice`). */
  mobile: boolean;
  /** Shadow map edge ceiling (`effectiveShadowSettings`'s `mapSizeCap`), or null for none. */
  shadowMapCap: ShadowMapSizeCap | null;
  /**
   * Texture cache ceiling: a quality level's, the Engine Settings' or a view's larger budget is lowered to it. With
   * the texture budget turned off in Engine Settings nothing is evicted, here too: that is the user's choice.
   */
  textureByteCeiling: number;
  /** Play's load rehearsal: whether it rehearses repeats of a kind, and when it ends. */
  loadRehearsal: { repeats: boolean; ceilingMs: number };
  /** Distinct rect area light emission textures the lighting plan's path holds at once (5.3 MiB each). */
  areaEmissionLayers: number;
  /**
   * The most lights of each type the lighting plan's light block draws at once (at most `HAPTIC_LIGHT_MAXIMUM`): every
   * lit pixel loops over the lights in use. Lights past it are ranked out as the Local Light Budget ranks them.
   */
  lightMaximum: { directional: number; point: number; spot: number; rect: number };
  /** The lighting plan's shadow atlas edge ceiling in texels (`shadowAtlasEdge`), or null for none. */
  shadowAtlasCap: number | null;
}

/**
 * Desktops and laptops. The rehearsal's ceiling leaves room inside the first presentation's own compile watch, which
 * renews its budget for `SCENE_PREPARATION_CEILING_MS` (300 s) from its start, for the frame it then presents.
 */
const DESKTOP: DeviceProfile = {
  mobile: false,
  shadowMapCap: null,
  textureByteCeiling: TEXTURE_BYTE_CEILING,
  loadRehearsal: { repeats: true, ceilingMs: 120_000 },
  areaEmissionLayers: 4,
  lightMaximum: { directional: 4, point: 32, spot: 16, rect: 4 },
  shadowAtlasCap: null,
};

/**
 * Phones and tablets: WKWebView kills a page past its memory limit and iPad WebKit compiles a rehearsal step's
 * variants in ten seconds or more, so maps and textures stay at the Medium level's (the A16 iPad's) and the
 * rehearsal leaves out repeats and ends sooner. What it leaves out compiles when gameplay first makes that change.
 * The light block draws half the desktop's lights, which a mobile GPU loops over in every lit pixel, and its shadow
 * atlas holds the capped maps (16 MiB).
 */
const MOBILE: DeviceProfile = {
  mobile: true,
  shadowMapCap: MOBILE_SHADOW_MAP_CAP,
  textureByteCeiling: 768 * MIB,
  loadRehearsal: { repeats: false, ceilingMs: 45_000 },
  areaEmissionLayers: 2,
  lightMaximum: { directional: 2, point: 16, spot: 8, rect: 2 },
  shadowAtlasCap: 2048,
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
