import {
  discoverEnginePlugins,
  encodePluginSettingsDocument,
  exportPluginZip,
  inspectHplugin,
  uniquePluginFolderName,
  normalizePluginSettings,
  type PluginSettingsPayload,
  type PluginDescriptor,
} from "@haptic/assets";
import { newGuid, type ProjectStorage } from "@haptic/core";
import {
  createMountedProjectStorage,
  type ProjectStorageMount,
  createTemplateStorage,
  ENGINE_PLUGIN_LIBRARY_FOLDER,
  MemoryStorageAdapter,
} from "@haptic/vfs";
import {
  captureLibraryFile, createLibraryQueue, LIBRARY_DEFAULTS_FILE, readLibraryDefaults,
  resolveLibraryImport, restoreLibraryFiles, sameLibraryIdentity, writeLibraryDefaults,
} from "./engine-library";
import { ensureEnginePluginStorage, isCachedEnginePluginStorage } from "./engine-plugins";

export const ENGINE_PLUGIN_LIBRARY_ROOT = ENGINE_PLUGIN_LIBRARY_FOLDER;
const CATALOG_FILE = "catalog.json";
const CATALOG_VERSION = 1;

interface StoredPlugin {
  generationPath: string;
  settingsPath: string;
  settings: PluginSettingsPayload;
}

export interface EnginePluginEntry extends PluginDescriptor {
  bundled: boolean;
  enabledByDefault: boolean;
}

export type EnginePluginImportResult =
  | { status: "imported"; entry: EnginePluginEntry }
  | { status: "conflict"; existing: EnginePluginEntry };

interface LibraryState {
  entries: EnginePluginEntry[];
  records: StoredPlugin[];
  defaults: Record<string, boolean>;
}

const pluginGuidOf = (entry: EnginePluginEntry) => entry.pluginGuid;

/** App-owned immutable plugin generations and creation defaults, separate from project copies. */
export class EnginePluginLibrary {
  private readonly serialize = createLibraryQueue();
  private readonly bundledStorage: ProjectStorage;
  private readonly libraryStorage: ProjectStorage;

  constructor(
    bundledStorage: ProjectStorage,
    libraryStorage: ProjectStorage,
  ) {
    this.bundledStorage = bundledStorage;
    this.libraryStorage = libraryStorage;
  }

  private async readRecords(): Promise<StoredPlugin[]> {
    if (!(await this.libraryStorage.exists(CATALOG_FILE))) return [];
    const catalog = JSON.parse(await this.libraryStorage.readText(CATALOG_FILE)) as { version?: unknown; plugins?: unknown };
    if (catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.plugins)) throw new Error("Unsupported Engine Plugin storage catalog.");
    return catalog.plugins.map((value: unknown) => {
      const entry = value as Partial<StoredPlugin>;
      if (!entry || typeof entry.generationPath !== "string" || !/^content\/[A-Za-z0-9-]+$/.test(entry.generationPath) ||
        typeof entry.settingsPath !== "string" || !entry.settingsPath || entry.settingsPath.startsWith("/") || entry.settingsPath.split("/").some((part) => part === "..") ||
        typeof entry.settings?.pluginGuid !== "string" || !entry.settings.pluginGuid.trim()) {
        throw new Error("Invalid Engine Plugin storage catalog.");
      }
      return { generationPath: entry.generationPath, settingsPath: entry.settingsPath, settings: normalizePluginSettings(entry.settings, { pluginGuid: entry.settings.pluginGuid }) };
    });
  }

  private writeRecords(records: readonly StoredPlugin[]): Promise<void> {
    return this.libraryStorage.writeText(CATALOG_FILE, JSON.stringify({ version: CATALOG_VERSION, plugins: records }));
  }

  private async storeGeneration(incoming: Awaited<ReturnType<typeof inspectHplugin>>): Promise<StoredPlugin> {
    const generationPath = `content/${newGuid()}`;
    for (const file of incoming.files) {
      const path = `${generationPath}/${file.path}`;
      const slash = path.lastIndexOf("/");
      await this.libraryStorage.mkdir(path.slice(0, slash), true);
      await this.libraryStorage.writeBinary(path, file.data);
    }
    return { generationPath, settingsPath: incoming.settingsPath, settings: incoming.settings };
  }

  private async readState(): Promise<LibraryState> {
    const defaults = await readLibraryDefaults(this.libraryStorage);
    const entries: EnginePluginEntry[] = [];
    const records = await this.readRecords();
    const folderNames: string[] = [];
    const append = (descriptor: PluginDescriptor, bundled: boolean) => {
      const enabledByDefault =
        defaults[descriptor.pluginGuid] ?? descriptor.settings.enabledByDefault;
      const entry: EnginePluginEntry = {
        ...descriptor,
        settings: { ...descriptor.settings, enabledByDefault },
        bundled,
        enabledByDefault,
      };
      folderNames.push(entry.folderName);
      entries.push(entry);
      return entry;
    };
    for (const plugin of await discoverEnginePlugins(this.bundledStorage)) {
      append(plugin, true);
    }
    for (const incoming of records) {
      // An engine update may introduce a bundled name/GUID already in the library.
      // The bundled original remains authoritative; never let a user archive replace it.
      if (sameLibraryIdentity(entries, pluginGuidOf, incoming.settings.pluginGuid, incoming.settings.displayName).length > 0) {
        continue;
      }
      const folderName = uniquePluginFolderName(incoming.settings.displayName, folderNames);
      append({
        pluginGuid: incoming.settings.pluginGuid,
        folderName,
        folderPath: folderName,
        settingsPath: `${folderName}/${incoming.settingsPath}`,
        contentPath: `${folderName}/assets`,
        source: "engine",
        readOnly: true,
        settings: incoming.settings,
      }, false);
    }
    return { entries, records, defaults };
  }

  private async captureStorage(state: LibraryState): Promise<ProjectStorage> {
    const settings = new MemoryStorageAdapter("opfs");
    await settings.openDocumentsProject("engine-plugin-settings-snapshot");
    const mounts: ProjectStorageMount[] = [];
    for (const entry of state.entries) {
      const record = state.records.find((candidate) => candidate.settings.pluginGuid === entry.pluginGuid);
      if (!entry.bundled && !record) throw new Error(`Missing storage generation for Engine Plugin ${entry.pluginGuid}`);
      mounts.push({ path: entry.folderPath, storage: entry.bundled ? this.bundledStorage : this.libraryStorage,
        sourcePath: entry.bundled ? entry.folderPath : record!.generationPath });
      const settingsPath = `settings-${mounts.length}.hasset`;
      await settings.writeBinary(settingsPath, await encodePluginSettingsDocument(entry.settings));
      mounts.push({ path: entry.settingsPath, storage: settings, sourcePath: settingsPath });
    }
    return createMountedProjectStorage(mounts, `engine-plugin-snapshot-${newGuid()}`);
  }

  list(): Promise<EnginePluginEntry[]> {
    return this.serialize(async () => (await this.readState()).entries);
  }

  /** A captured library is immutable; later edits cannot change an open project. */
  createStorageSnapshot(): Promise<ProjectStorage> {
    return this.serialize(async () => this.captureStorage(await this.readState()));
  }

  export(guid: string): Promise<Uint8Array> {
    return this.serialize(async () => {
      const state = await this.readState();
      const entry = state.entries.find((plugin) => plugin.pluginGuid === guid);
      if (!entry) throw new Error("The Engine Plugin no longer exists.");
      const storage = await this.captureStorage({ ...state, entries: [entry] });
      return exportPluginZip(storage, entry);
    });
  }

  setEnabledByDefault(guid: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const { entries, defaults } = await this.readState();
      if (!entries.some((entry) => entry.pluginGuid === guid)) {
        throw new Error("The Engine Plugin no longer exists.");
      }
      defaults[guid] = enabled;
      await writeLibraryDefaults(this.libraryStorage, defaults);
    });
  }

  remove(guid: string): Promise<void> {
    return this.serialize(async () => {
      const { entries, records, defaults } = await this.readState();
      const entry = entries.find((plugin) => plugin.pluginGuid === guid);
      if (!entry) throw new Error("The Engine Plugin no longer exists.");
      if (entry.bundled) throw new Error("Bundled Engine Plugins cannot be deleted.");
      // Existing snapshots retain immutable generations; only catalog ownership changes.
      await this.writeRecords(records.filter((record) => record.settings.pluginGuid !== guid));
      delete defaults[guid];
      await writeLibraryDefaults(this.libraryStorage, defaults);
    });
  }

  import(
    bytes: Uint8Array,
    options: { replaceGuid?: string } = {},
  ): Promise<EnginePluginImportResult> {
    return this.serialize(async () => {
      const incoming = await inspectHplugin(bytes);
      const { entries, records, defaults } = await this.readState();
      const target = resolveLibraryImport(entries, pluginGuidOf, {
        guid: incoming.settings.pluginGuid, displayName: incoming.settings.displayName,
      }, options.replaceGuid, "Plugin");
      if ("conflict" in target) return { status: "conflict", existing: target.conflict };
      const { existing } = target;
      if (existing) {
        delete defaults[existing.pluginGuid];
        defaults[incoming.settings.pluginGuid] = existing.enabledByDefault;
      }
      const generation = await this.storeGeneration(incoming);
      const previousCatalog = await captureLibraryFile(this.libraryStorage, CATALOG_FILE);
      const previousDefaults = await captureLibraryFile(this.libraryStorage, LIBRARY_DEFAULTS_FILE);
      try {
        await this.writeRecords([...records.filter((record) => record.settings.pluginGuid !== existing?.pluginGuid), generation]);
        await writeLibraryDefaults(this.libraryStorage, defaults);
        const entry = (await this.readState()).entries.find(
          (plugin) => plugin.pluginGuid === incoming.settings.pluginGuid,
        );
        if (!entry) throw new Error("Export did not produce an Engine Plugin.");
        return { status: "imported", entry };
      } catch (cause) {
        // The new generation folder stays unreferenced; restore the catalog and
        // defaults so the library lists exactly what it did before the import.
        return restoreLibraryFiles(this.libraryStorage,
          [[CATALOG_FILE, previousCatalog], [LIBRARY_DEFAULTS_FILE, previousDefaults]], cause, "Plugin");
      }
    });
  }
}

let cachedLibrary: Promise<EnginePluginLibrary> | null = null;

export function ensureEnginePluginLibrary(): Promise<EnginePluginLibrary> {
  if (!cachedLibrary) {
    cachedLibrary = Promise.all([
      ensureEnginePluginStorage(),
      createTemplateStorage(ENGINE_PLUGIN_LIBRARY_ROOT),
    ]).then(([bundled, library]) => {
      // Never pin the session to the empty fallback: New Project would copy no
      // bundled plugins until reload. The next call retries the bundled index.
      if (!isCachedEnginePluginStorage(bundled)) cachedLibrary = null;
      return new EnginePluginLibrary(bundled, library);
    });
    void cachedLibrary.catch(() => { cachedLibrary = null; });
  }
  return cachedLibrary;
}
