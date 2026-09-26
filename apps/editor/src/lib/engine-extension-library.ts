import {
  discoverEngineExtensions,
  encodeExtensionSettings,
  exportExtensionZip,
  inspectBabextension,
  uniqueExtensionFolderName,
  unpackEngineExtensionZip,
  type ExtensionDescriptor,
} from "@babylonslate/assets";
import { newGuid, type ProjectStorage } from "@babylonslate/core";
import {
  createReadOnlyProjectStorage,
  createTemplateStorage,
  MemoryStorageAdapter,
} from "@babylonslate/vfs";
import { ensureEngineExtensionStorage } from "./engine-extensions";

export const ENGINE_EXTENSION_LIBRARY_ROOT = "__slate_engine_extensions__";
const DEFAULTS_FILE = "defaults.json";

export interface EngineExtensionEntry extends ExtensionDescriptor {
  bundled: boolean;
  enabledByDefault: boolean;
}

export type EngineExtensionImportResult =
  | { status: "imported"; entry: EngineExtensionEntry }
  | { status: "conflict"; existing: EngineExtensionEntry };

interface LibraryState {
  entries: EngineExtensionEntry[];
  archivePaths: Map<string, string>;
  defaults: Record<string, boolean>;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

/** App-owned extension archives and creation defaults, separate from project copies. */
export class EngineExtensionLibrary {
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

  private async readState(): Promise<LibraryState> {
    const defaults = await this.readDefaults();
    const entries: EngineExtensionEntry[] = [];
    const archivePaths = new Map<string, string>();
    const folderNames: string[] = [];
    const append = (descriptor: ExtensionDescriptor, bundled: boolean) => {
      const enabledByDefault =
        defaults[descriptor.extensionGuid] ?? descriptor.settings.enabledByDefault;
      const entry: EngineExtensionEntry = {
        ...descriptor,
        settings: { ...descriptor.settings, enabledByDefault },
        bundled,
        enabledByDefault,
      };
      folderNames.push(entry.folderName);
      entries.push(entry);
      return entry;
    };
    for (const extension of await discoverEngineExtensions(this.bundledStorage)) {
      append(extension, true);
    }
    const archives = (await this.libraryStorage.readdir("."))
      .filter((file) => !file.isDir && file.name.endsWith(".babextension"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const archive of archives) {
      const bytes = await this.libraryStorage.readBinary(archive.name);
      const incoming = await inspectBabextension(bytes);
      // An engine update may introduce a bundled name/GUID already in the library.
      // The bundled original remains authoritative; never let a user archive replace it.
      if (entries.some((entry) =>
        entry.extensionGuid === incoming.settings.extensionGuid ||
        normalizedName(entry.settings.displayName) === normalizedName(incoming.settings.displayName))) {
        continue;
      }
      const folderName = uniqueExtensionFolderName(incoming.settings.displayName, folderNames);
      const entry = append({
        extensionGuid: incoming.settings.extensionGuid,
        folderName,
        folderPath: folderName,
        settingsPath: `${folderName}/${incoming.settingsPath}`,
        contentPath: `${folderName}/assets`,
        source: "engine",
        readOnly: true,
        settings: incoming.settings,
      }, false);
      archivePaths.set(entry.extensionGuid, archive.name);
    }
    return { entries, archivePaths, defaults };
  }

  private async captureStorage(state: LibraryState): Promise<ProjectStorage> {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-extension-snapshot");
    for (const entry of state.entries) {
      const bytes = entry.bundled
        ? await exportExtensionZip(this.bundledStorage, entry)
        : await this.libraryStorage.readBinary(state.archivePaths.get(entry.extensionGuid)!);
      const copied = await unpackEngineExtensionZip(storage, bytes, entry.folderName);
      await storage.writeBinary(
        copied.settingsPath,
        encodeExtensionSettings(entry.settings),
      );
    }
    return createReadOnlyProjectStorage(storage);
  }

  list(): Promise<EngineExtensionEntry[]> {
    return this.serialize(async () => (await this.readState()).entries);
  }

  /** A captured library is immutable; later edits cannot change an open project. */
  createStorageSnapshot(): Promise<ProjectStorage> {
    return this.serialize(async () => this.captureStorage(await this.readState()));
  }

  export(guid: string): Promise<Uint8Array> {
    return this.serialize(async () => {
      const state = await this.readState();
      const entry = state.entries.find((extension) => extension.extensionGuid === guid);
      if (!entry) throw new Error("The Engine Extension no longer exists.");
      const storage = await this.captureStorage({ ...state, entries: [entry] });
      return exportExtensionZip(storage, entry);
    });
  }

  setEnabledByDefault(guid: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const { entries, defaults } = await this.readState();
      if (!entries.some((entry) => entry.extensionGuid === guid)) {
        throw new Error("The Engine Extension no longer exists.");
      }
      defaults[guid] = enabled;
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
    });
  }

  remove(guid: string): Promise<void> {
    return this.serialize(async () => {
      const { entries, archivePaths, defaults } = await this.readState();
      const entry = entries.find((extension) => extension.extensionGuid === guid);
      if (!entry) throw new Error("The Engine Extension no longer exists.");
      if (entry.bundled) throw new Error("Bundled Engine Extensions cannot be deleted.");
      const archivePath = archivePaths.get(guid)!;
      await this.libraryStorage.remove(archivePath);
      delete defaults[guid];
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
    });
  }

  import(
    bytes: Uint8Array,
    options: { replaceGuid?: string } = {},
  ): Promise<EngineExtensionImportResult> {
    return this.serialize(async () => {
      const incoming = await inspectBabextension(bytes);
      const { entries, archivePaths, defaults } = await this.readState();
      const conflicts = entries.filter((entry) =>
        entry.extensionGuid === incoming.settings.extensionGuid ||
        normalizedName(entry.settings.displayName) === normalizedName(incoming.settings.displayName));
      if (conflicts.some((entry) => entry.bundled)) {
        throw new Error("A bundled Engine Extension already uses this name or ID and cannot be replaced.");
      }
      if (conflicts.length > 1) {
        throw new Error("The extension name and ID match different Engine Extensions. Rename the extension before exporting.");
      }
      const existing = conflicts[0];
      if (existing && options.replaceGuid !== existing.extensionGuid) {
        return { status: "conflict", existing };
      }
      if (!existing && options.replaceGuid) {
        throw new Error("The Engine Extension changed. Export again to confirm the replacement.");
      }
      const archivePath = existing
        ? archivePaths.get(existing.extensionGuid)!
        : `${newGuid()}.babextension`;
      if (existing) {
        delete defaults[existing.extensionGuid];
        defaults[incoming.settings.extensionGuid] = existing.enabledByDefault;
      }
      await this.libraryStorage.writeBinary(archivePath, bytes);
      await this.libraryStorage.writeText(DEFAULTS_FILE, JSON.stringify(defaults));
      const entry = (await this.readState()).entries.find(
        (extension) => extension.extensionGuid === incoming.settings.extensionGuid,
      );
      if (!entry) throw new Error("Export did not produce an Engine Extension.");
      return { status: "imported", entry };
    });
  }
}

let cachedLibrary: Promise<EngineExtensionLibrary> | null = null;

export function ensureEngineExtensionLibrary(): Promise<EngineExtensionLibrary> {
  if (!cachedLibrary) {
    cachedLibrary = Promise.all([
      ensureEngineExtensionStorage(),
      createTemplateStorage(ENGINE_EXTENSION_LIBRARY_ROOT),
    ]).then(([bundled, library]) => new EngineExtensionLibrary(bundled, library));
    void cachedLibrary.catch(() => { cachedLibrary = null; });
  }
  return cachedLibrary;
}
