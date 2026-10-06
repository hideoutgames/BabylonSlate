import { discoverEnginePlugins } from "@babylonslate/assets";
import {
  MemoryStorageAdapter,
  HttpCatalogStorageAdapter,
  type HttpStorageCatalog,
  createReadOnlyProjectStorage,
} from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";

export const ENGINE_PLUGIN_INDEX_FILE = "index.json";

export function enginePluginPublicUrl(baseUrl: string, file: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}engine-plugins/${file}`;
}

export const lastEnginePluginLoad: {
  entries: number;
  unpacked: number;
  errors: string[];
} = { entries: 0, unpacked: 0, errors: [] };

export async function loadEnginePluginStorage(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): Promise<ProjectStorage> {
  lastEnginePluginLoad.entries = 0;
  lastEnginePluginLoad.unpacked = 0;
  lastEnginePluginLoad.errors = [];
  const storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject("engine-plugins");
  const baseUrl = options.baseUrl ?? "/";
  try {
    const response = await options.fetch(enginePluginPublicUrl(baseUrl, ENGINE_PLUGIN_INDEX_FILE));
    if (!response.ok) {
      lastEnginePluginLoad.errors.push(`index ${response.status}`);
      return createReadOnlyProjectStorage(storage);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const catalog = JSON.parse(new TextDecoder().decode(bytes)) as HttpStorageCatalog & { plugins?: Array<{ id: string }> };
    if (catalog.version !== 1 || !Array.isArray(catalog.plugins)) throw new Error("Engine plugin catalog requires a rebuilt editor bundle");
    const result = new HttpCatalogStorageAdapter(catalog, {
      fetch: options.fetch, baseUrl: enginePluginPublicUrl(baseUrl, ""), name: "engine-plugins", catalogBytesRead: bytes.byteLength,
    });
    lastEnginePluginLoad.entries = catalog.plugins.length;
    // Retained diagnostic field: counts mounted plugins; no archives are unpacked.
    lastEnginePluginLoad.unpacked = catalog.plugins.length;
    return result;
  } catch (error) {
    lastEnginePluginLoad.errors.push(`index ${error instanceof Error ? error.message : String(error)}`);
  }
  return createReadOnlyProjectStorage(storage);
}

let cachedEnginePluginStorage: ProjectStorage | null = null;

/** Fetch bundled engine plugins once per editor session after a successful load. */
export async function ensureEnginePluginStorage(options?: {
  fetch?: typeof fetch;
  baseUrl?: string;
}): Promise<ProjectStorage> {
  if (cachedEnginePluginStorage) return cachedEnginePluginStorage;
  const storage = await loadEnginePluginStorage({
    fetch: options?.fetch ?? fetch.bind(globalThis),
    baseUrl: options?.baseUrl ?? import.meta.env.BASE_URL,
  });
  const discovered = await discoverEnginePlugins(storage);
  if (discovered.length > 0) {
    cachedEnginePluginStorage = storage;
  }
  return storage;
}
