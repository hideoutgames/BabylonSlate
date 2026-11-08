import { decodeExtensionSettings } from "@haptic/assets";
import { createReadOnlyProjectStorage, MemoryStorageAdapter } from "@haptic/vfs";
import type { ProjectStorage } from "@haptic/core";
import manifest from "../../../../engine-extensions/glsl-to-material/extension.json?raw";
import source from "../../../../engine-extensions/glsl-to-material/index.js?raw";

let bundled: Promise<ProjectStorage> | null = null;

/** Bundled extensions; only a gameplay (not Editor Only) one reaches games, as a linked library and a content root. */
export function ensureEngineExtensionStorage(): Promise<ProjectStorage> {
  bundled ??= (async () => {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("bundled-engine-extensions");
    const settings = decodeExtensionSettings(new TextEncoder().encode(manifest));
    await storage.mkdir("glsl-to-material/assets", true);
    await storage.writeText("glsl-to-material/extension.json", manifest);
    await storage.writeText(`glsl-to-material/${settings.entryPoint}`, source);
    return createReadOnlyProjectStorage(storage);
  })();
  return bundled;
}
