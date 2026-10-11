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
  errors: string[];
} = { entries: 0, errors: [] };

/** Read-only storage with no plugins, used when the bundled index cannot be read. */
async function emptyEnginePluginStorage(): Promise<ProjectStorage> {
  const storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject("engine-plugins");
  return createReadOnlyProjectStorage(storage);
}

/** Mount the bundled plugin catalog; file parts are fetched on demand, never as archives. */
export async function loadEnginePluginStorage(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): Promise<ProjectStorage> {
  lastEnginePluginLoad.entries = 0;
  lastEnginePluginLoad.errors = [];
  const baseUrl = options.baseUrl ?? "/";
  try {
    // Call fetch unbound: the platform fetch rejects any `this` but the global.
    const fetchCatalog = options.fetch;
    const response = await fetchCatalog(enginePluginPublicUrl(baseUrl, ENGINE_PLUGIN_INDEX_FILE));
    if (!response.ok) {
      lastEnginePluginLoad.errors.push(`index ${response.status}`);
      return emptyEnginePluginStorage();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const catalog = JSON.parse(new TextDecoder().decode(bytes)) as HttpStorageCatalog & { plugins?: Array<{ id: string }> };
    if (catalog.version !== 1 || !Array.isArray(catalog.plugins)) throw new Error("Engine plugin catalog requires a rebuilt editor bundle");
    const result = new HttpCatalogStorageAdapter(catalog, {
      fetch: options.fetch, baseUrl: enginePluginPublicUrl(baseUrl, ""), name: "engine-plugins", catalogBytesRead: bytes.byteLength,
    });
    lastEnginePluginLoad.entries = catalog.plugins.length;
    return result;
  } catch (error) {
    lastEnginePluginLoad.errors.push(`index ${error instanceof Error ? error.message : String(error)}`);
  }
  return emptyEnginePluginStorage();
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
