import { registerPlugin } from "@capacitor/core";
import { getHostPlatform } from "./platform";

/**
 * Memory counters for the Play debugger stats HUD. Every field is optional:
 * each source reports only where the platform exposes it.
 *
 * - `jsHeapBytes`: JS heap in use, Chromium/Electron only (`performance.memory`).
 * - `appFootprintBytes`: host app process footprint on iOS (excludes the
 *   separate WKWebView content process, which iOS does not expose).
 * - `appAvailableBytes`: bytes until jetsam would kill the app process.
 * - `systemAvailableBytes`: device-wide free + inactive + purgeable memory.
 */
export type HostMemoryStats = {
  jsHeapBytes?: number;
  appFootprintBytes?: number;
  appAvailableBytes?: number;
  systemAvailableBytes?: number;
};

interface BabylonSlateMemoryPlugin {
  stats(): Promise<{
    appFootprintBytes?: number | null;
    appAvailableBytes?: number | null;
    systemAvailableBytes?: number | null;
  }>;
}

const BabylonSlateMemory = registerPlugin<BabylonSlateMemoryPlugin>(
  "BabylonSlateMemory",
);

/** Poll-friendly: returns null when no source can report on this platform. */
export async function getHostMemoryStats(): Promise<HostMemoryStats | null> {
  const stats: HostMemoryStats = {};

  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }
  ).memory;
  if (typeof memory?.usedJSHeapSize === "number") {
    stats.jsHeapBytes = memory.usedJSHeapSize;
  }

  // The native plugin is iOS-only; Android and desktop have no bridge.
  if (getHostPlatform() === "ios") {
    try {
      const native = await BabylonSlateMemory.stats();
      if (typeof native.appFootprintBytes === "number") {
        stats.appFootprintBytes = native.appFootprintBytes;
      }
      if (typeof native.appAvailableBytes === "number") {
        stats.appAvailableBytes = native.appAvailableBytes;
      }
      if (typeof native.systemAvailableBytes === "number") {
        stats.systemAvailableBytes = native.systemAvailableBytes;
      }
    } catch {
      // Plugin absent (older native shell) — keep whatever JS reported.
    }
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
