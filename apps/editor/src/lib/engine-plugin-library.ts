import {
  discoverEnginePlugins,
  encodePluginSettingsDocument,
  exportPluginZip,
  inspectBabplugin,
  uniquePluginFolderName,
  unpackEnginePluginZip,
  type PluginDescriptor,
} from "@babylonslate/assets";
import { newGuid, type ProjectStorage } from "@babylonslate/core";
import {
  createReadOnlyProjectStorage,
  createTemplateStorage,
  MemoryStorageAdapter,
} from "@babylonslate/vfs";
import { ensureEnginePluginStorage } from "./engine-plugins";

export const ENGINE_PLUGIN_LIBRARY_ROOT = "__slate_engine_plugins__";
const DEFAULTS_FILE = "defaults.json";

export interface EnginePluginEntry extends PluginDescriptor {
  bundled: boolean;
  enabledByDefault: boolean;
}

export type EnginePluginImportResult =
  | { status: "imported"; entry: EnginePluginEntry }
  | { status: "conflict"; existing: EnginePluginEntry };

interface LibrarySnapshot {
  storage: ProjectStorage;
  entries: EnginePluginEntry[];
  archivePaths: Map<string, string>;
  defaults: Record<string, boolean>;
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** App-owned plugin archives and creation defaults, separate from project copies. */
export class EnginePluginLibrary {
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bundledStorage: ProjectStorage,
    private readonly libraryStorage: ProjectStorage,
  ) {}

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async readDefaults(): Promise<Record<string, boolean>> {
    if (!(await this.libraryStorage.exists(DEFAULTS_FILE))) return {};
    const value: unknown = JSON.parse(await this.libraryStorage.readText(DEFAULTS_FILE));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, boolean] =>
        typeof entry[1] === "boolean"),
    );
  }

  private async snapshot(): Promise<LibrarySnapshot> {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugin-snapshot");
    const defaults = await this.readDefaults();
    const entries: EnginePluginEntry[] = [];
    const archivePaths = new Map<string, string>();
    const folderNames: string[] = [];
    const append = async (bytes: Uint8Array, folder: string, bundled: boolean) => {
      const folderName = uniquePluginFolderName(folder, folderNames);
      folderNames.push(folderName);
      const descriptor = await unpackEnginePluginZip(storage, bytes, folderName);
      descriptor.settings.enabledByDefault =
        defaults[descriptor.pluginGuid] ?? descriptor.settings.enabledByDefault;
      await storage.writeBinary(
        descriptor.settingsPath,
        await encodePluginSettingsDocument(descriptor.settings),
      );
      const entry: EnginePluginEntry = {
        ...descriptor,
        bundled,
        enabledByDefault: descriptor.settings.enabledByDefault,
      };
      entries.push(entry);
      return entry;
    };
    for (const plugin of await discoverEnginePlugins(this.bundledStorage)) {
      await append(
        await exportPluginZip(this.bundledStorage, plugin),
        plugin.folderName,
        true,
      );
    }
    const archives = (await this.libraryStorage.readdir("."))
      .filter((file) => !file.isDir && file.name.endsWith(".babplugin"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const archive of archives) {
      const bytes = await this.libraryStorage.readBinary(archive.name);
      const incoming = await inspectBabplugin(bytes);
      // An engine update may introduce a bundled name/GUID already in the library.
      // The bundled original remains authoritative; never let a user archive replace it.
      if (entries.some((entry) =>
        entry.pluginGuid === incoming.settings.pluginGuid ||
        normalizedName(entry.settings.displayName) === normalizedName(incoming.settings.displayName))) {
        continue;
      }
      const entry = await append(bytes, incoming.settings.displayName, false);
      archivePaths.set(entry.pluginGuid, archive.name);
    }
    return { storage: createReadOnlyProjectStorage(storage), entries, archivePaths, defaults };
  }

  async list(): Promise<EnginePluginEntry[]> {
    await this.mutation;
    return (await this.snapshot()).entries;
  }

  /** A captured library is immutable; later edits cannot change an open project. */
  async createStorageSnapshot(): Promise<ProjectStorage> {
    await this.mutation;
    return (await this.snapshot()).storage;
  }

  async export(guid: string): Promise<Uint8Array> {
    await this.mutation;
    const { storage, entries } = await this.snapshot();
    const entry = entries.find((plugin) => plugin.pluginGuid === guid);
    if (!entry) throw new Error("The Engine Plugin no longer exists.");
    return exportPluginZip(storage, entry);
  }

  setEnabledByDefault(guid: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      const { entries, defaults } = await this.snapshot();
      if (!entries.some((entry) => entry.pluginGuid === guid)) {
        throw new Error("The Engine Plugin no longer exists.");
      }
      defaults[guid] = enabled;
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
    });
  }

  remove(guid: string): Promise<void> {
    return this.mutate(async () => {
      const { entries, archivePaths, defaults } = await this.snapshot();
      const entry = entries.find((plugin) => plugin.pluginGuid === guid);
      if (!entry) throw new Error("The Engine Plugin no longer exists.");
      if (entry.bundled) throw new Error("Bundled Engine Plugins cannot be deleted.");
      const archivePath = archivePaths.get(guid)!;
      await this.libraryStorage.remove(archivePath);
      delete defaults[guid];
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
    });
  }

  import(
    bytes: Uint8Array,
    options: { replaceGuid?: string } = {},
  ): Promise<EnginePluginImportResult> {
    return this.mutate(async () => {
      const incoming = await inspectBabplugin(bytes);
      const { entries, archivePaths, defaults } = await this.snapshot();
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
      const archivePath = existing
        ? archivePaths.get(existing.pluginGuid)!
        : `${newGuid()}.babplugin`;
      if (existing) {
        delete defaults[existing.pluginGuid];
        defaults[incoming.settings.pluginGuid] = existing.enabledByDefault;
      }
      await this.libraryStorage.writeBinary(archivePath, bytes);
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
      const entry = (await this.snapshot()).entries.find(
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
