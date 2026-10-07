import {
  discoverEnginePlugins,
  encodePluginSettingsDocument,
  exportPluginZip,
  inspectBabplugin,
  uniquePluginFolderName,
  normalizePluginSettings,
  type PluginSettingsPayload,
  type PluginDescriptor,
} from "@babylonslate/assets";
import { newGuid, type ProjectStorage } from "@babylonslate/core";
import {
  createMountedProjectStorage,
  type ProjectStorageMount,
  createTemplateStorage,
  MemoryStorageAdapter,
} from "@babylonslate/vfs";
import { ensureEnginePluginStorage } from "./engine-plugins";

export const ENGINE_PLUGIN_LIBRARY_ROOT = "__slate_engine_plugins__";
const DEFAULTS_FILE = "defaults.json";
const CATALOG_FILE = "catalog.json";
const CATALOG_VERSION = 1;

interface StoredPlugin {
  generationPath: string;
  settingsPath: string;
  settings: PluginSettingsPayload;
}

export class EnginePluginLibraryUpgradeRequiredError extends Error {
  readonly code = "engine-plugin-library-upgrade-required";
  readonly archiveCount: number;
  constructor(archiveCount: number) {
    super(`${archiveCount} Engine Plugin archive(s) need a one-time storage upgrade. Open Engine Settings → Plugins and choose Upgrade Plugin Storage.`);
    this.name = "EnginePluginLibraryUpgradeRequiredError";
    this.archiveCount = archiveCount;
  }
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

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

/** App-owned immutable plugin generations and creation defaults, separate from project copies. */
export class EnginePluginLibrary {
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly bundledStorage: ProjectStorage;
  private readonly libraryStorage: ProjectStorage;

  constructor(
    bundledStorage: ProjectStorage,
    libraryStorage: ProjectStorage,
  ) {
    this.bundledStorage = bundledStorage;
    this.libraryStorage = libraryStorage;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async readDefaults(): Promise<Record<string, boolean>> {
    const defaults: Record<string, boolean> = Object.create(null);
    if (!(await this.libraryStorage.exists(DEFAULTS_FILE))) return defaults;
    const value: unknown = JSON.parse(await this.libraryStorage.readText(DEFAULTS_FILE));
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
    for (const [guid, enabled] of Object.entries(value)) {
      if (typeof enabled === "boolean") defaults[guid] = enabled;
    }
    return defaults;
  }

  private async legacyArchives(): Promise<string[]> {
    return (await this.libraryStorage.readdir("."))
      .filter((file) => !file.isDir && file.name.endsWith(".babplugin"))
      .map((file) => file.name).sort();
  }

  private async readRecords(allowLegacy = false): Promise<StoredPlugin[]> {
    if (!(await this.libraryStorage.exists(CATALOG_FILE))) {
      const archives = await this.legacyArchives();
      if (!allowLegacy && archives.length > 0) throw new EnginePluginLibraryUpgradeRequiredError(archives.length);
      return [];
    }
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

  private async storeGeneration(incoming: Awaited<ReturnType<typeof inspectBabplugin>>): Promise<StoredPlugin> {
    const generationPath = `content/${newGuid()}`;
    for (const file of incoming.files) {
      const path = `${generationPath}/${file.path}`;
      const slash = path.lastIndexOf("/");
      await this.libraryStorage.mkdir(path.slice(0, slash), true);
      await this.libraryStorage.writeBinary(path, file.data);
    }
    return { generationPath, settingsPath: incoming.settingsPath, settings: incoming.settings };
  }

  /** Explicitly expands old archives once; opening/listing never reads their payloads. */
  upgradeLegacyArchives(): Promise<number> {
    return this.serialize(async () => {
      const archives = await this.legacyArchives();
      const records = await this.readRecords(true);
      for (const archive of archives) {
        const incoming = await inspectBabplugin(await this.libraryStorage.readBinary(archive));
        if (!records.some((record) => record.settings.pluginGuid === incoming.settings.pluginGuid)) {
          records.push(await this.storeGeneration(incoming));
        }
      }
      await this.writeRecords(records);
      for (const archive of archives) await this.libraryStorage.remove(archive);
      return archives.length;
    });
  }

  private async readState(): Promise<LibraryState> {
    const defaults = await this.readDefaults();
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
      if (entries.some((entry) =>
        entry.pluginGuid === incoming.settings.pluginGuid ||
        normalizedName(entry.settings.displayName) === normalizedName(incoming.settings.displayName))) {
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
      const settingsPath = `settings-${mounts.length}.babasset`;
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
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
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
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
    });
  }

  import(
    bytes: Uint8Array,
    options: { replaceGuid?: string } = {},
  ): Promise<EnginePluginImportResult> {
    return this.serialize(async () => {
      const incoming = await inspectBabplugin(bytes);
      const { entries, records, defaults } = await this.readState();
      const conflicts = entries.filter((entry) =>
        entry.pluginGuid === incoming.settings.pluginGuid ||
        normalizedName(entry.settings.displayName) === normalizedName(incoming.settings.displayName));
      if (conflicts.some((entry) => entry.bundled)) {
        throw new Error("A bundled Engine Plugin already uses this name or ID and cannot be replaced.");
      }
      if (conflicts.length > 1) {
        throw new Error("The plugin name and ID match different Engine Plugins. Rename the plugin before exporting.");
      }
      const existing = conflicts[0];
      if (existing && options.replaceGuid !== existing.pluginGuid) {
        return { status: "conflict", existing };
      }
      if (!existing && options.replaceGuid) {
        throw new Error("The Engine Plugin changed. Export again to confirm the replacement.");
      }
      if (existing) {
        delete defaults[existing.pluginGuid];
        defaults[incoming.settings.pluginGuid] = existing.enabledByDefault;
      }
      const generation = await this.storeGeneration(incoming);
      await this.writeRecords([...records.filter((record) => record.settings.pluginGuid !== existing?.pluginGuid), generation]);
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
      const entry = (await this.readState()).entries.find(
        (plugin) => plugin.pluginGuid === incoming.settings.pluginGuid,
      );
      if (!entry) throw new Error("Export did not produce an Engine Plugin.");
      return { status: "imported", entry };
    });
  }
}

let cachedLibrary: Promise<EnginePluginLibrary> | null = null;

export function ensureEnginePluginLibrary(): Promise<EnginePluginLibrary> {
  if (!cachedLibrary) {
    cachedLibrary = Promise.all([
      ensureEnginePluginStorage(),
      createTemplateStorage(ENGINE_PLUGIN_LIBRARY_ROOT),
    ]).then(([bundled, library]) => new EnginePluginLibrary(bundled, library));
    void cachedLibrary.catch(() => { cachedLibrary = null; });
  }
  return cachedLibrary;
}
