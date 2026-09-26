import { decodeExtensionSettings } from "@babylonslate/assets";
import { createReadOnlyProjectStorage, MemoryStorageAdapter } from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";
import manifest from "../../../../engine-extensions/glsl-to-material/extension.json?raw";
import source from "../../../../engine-extensions/glsl-to-material/index.js?raw";

let bundled: Promise<ProjectStorage> | null = null;

/** Bundled editor code never enters the player bundle or project asset registry. */
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
