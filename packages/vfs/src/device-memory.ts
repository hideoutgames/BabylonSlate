import { registerPlugin } from "@capacitor/core";
import { isMobilePlatform } from "./platform";

/**
 * Memory counters for the Play debugger stats HUD. Every field is optional:
 * each source reports only where the platform exposes it.
 *
 * - `jsHeapBytes`: JS heap in use, Chromium/Electron only (`performance.memory`).
 * - `appFootprintBytes`: native host process footprint on iOS/Android (excludes
 *   the separate WebView content process).
 * - `appAvailableBytes`: bytes until iOS jetsam would kill the app process.
 * - `systemAvailableBytes`: device-wide memory exposed by the native host.
 * - `rendererProcessBytes`, `gpuProcessBytes`, `mainProcessBytes`, `allProcessesBytes`:
 *   resident memory of the Electron desktop app's processes (the GPU process holds WebGL resources).
 */
export type HostMemoryStats = {
  jsHeapBytes?: number;
  appFootprintBytes?: number;
  appAvailableBytes?: number;
  systemAvailableBytes?: number;
  rendererProcessBytes?: number;
  gpuProcessBytes?: number;
  mainProcessBytes?: number;
  allProcessesBytes?: number;
};

type ElectronMemoryBridge = {
  stats(): Promise<Partial<Record<"rendererProcessBytes" | "gpuProcessBytes" | "mainProcessBytes" | "allProcessesBytes", number | null>>>;
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

let latest: { stats: HostMemoryStats; at: number } | null = null;

/** The last sample `getHostMemoryStats` read, for reports built synchronously inside a tap. */
export function latestHostMemoryStats(): { stats: HostMemoryStats; at: number } | null {
  return latest;
}

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

  // First-party iOS and Android shells expose host-process counters.
  if (isMobilePlatform()) {
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

  // The Electron preload reports every app process, the GPU process included.
  const electron = (globalThis as { haptic?: { memory?: ElectronMemoryBridge } }).haptic?.memory;
  if (electron) {
    try {
      const desktop = await electron.stats();
      for (const key of ["rendererProcessBytes", "gpuProcessBytes", "mainProcessBytes", "allProcessesBytes"] as const) {
        const value = desktop[key];
        if (typeof value === "number") stats[key] = value;
      }
    } catch {
      // An older desktop shell without the channel.
    }
  }

  if (Object.keys(stats).length === 0) return null;
  latest = { stats, at: performance.now() };
  return stats;
}
