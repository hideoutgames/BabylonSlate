// #if WITH_MOBILE
import { registerPlugin } from "@capacitor/core";

interface BabylonSlateMemoryPlugin {
  stats(): Promise<{
    appFootprintBytes?: number | null;
    appAvailableBytes?: number | null;
    systemAvailableBytes?: number | null;
  }>;
}

let plugin: BabylonSlateMemoryPlugin | null = null;

/** The iOS and Android shells' host-process memory counters (`getHostMemoryStats`). */
export function nativeMemoryStats(): ReturnType<BabylonSlateMemoryPlugin["stats"]> {
  plugin ??= registerPlugin<BabylonSlateMemoryPlugin>("BabylonSlateMemory");
  return plugin.stats();
}
// #endif
