import {
  discoverEnginePlugins,
  unpackEnginePluginZip,
} from "@babylonslate/assets";
import {
  MemoryStorageAdapter,
  createReadOnlyProjectStorage,
} from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";

export const ENGINE_PLUGIN_INDEX_FILE = "index.json";

export function enginePluginPublicUrl(baseUrl: string, file: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}engine-plugins/${file}`;
}

interface EnginePluginIndexEntry {
  id: string;
  file: string;
}

function parseIndex(value: unknown): EnginePluginIndexEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: EnginePluginIndexEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const file = typeof record.file === "string" ? record.file.trim() : "";
    if (!id || !file) continue;
    entries.push({ id, file });
  }
  return entries;
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
  let entries: EnginePluginIndexEntry[] = [];
  try {
    const response = await options.fetch(
      enginePluginPublicUrl(baseUrl, ENGINE_PLUGIN_INDEX_FILE),
    );
    if (!response.ok) {
      lastEnginePluginLoad.errors.push(`index ${response.status}`);
      return createReadOnlyProjectStorage(storage);
    }
    entries = parseIndex(await response.json());
    lastEnginePluginLoad.entries = entries.length;
  } catch (error) {
    lastEnginePluginLoad.errors.push(
      `index ${error instanceof Error ? error.message : String(error)}`,
    );
    return createReadOnlyProjectStorage(storage);
  }
  for (const entry of entries) {
    try {
      const zipResponse = await options.fetch(
        enginePluginPublicUrl(baseUrl, entry.file),
      );
      if (!zipResponse.ok) {
        lastEnginePluginLoad.errors.push(`${entry.id} ${zipResponse.status}`);
        continue;
      }
      const bytes = new Uint8Array(await zipResponse.arrayBuffer());
      await unpackEnginePluginZip(storage, bytes, entry.id);
      lastEnginePluginLoad.unpacked += 1;
    } catch (error) {
      lastEnginePluginLoad.errors.push(
        `${entry.id} ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
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
