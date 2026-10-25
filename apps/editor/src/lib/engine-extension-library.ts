import {
  createExtensionSettings,
  discoverEngineExtensions,
  encodeExtensionSettings,
  exportExtensionZip,
  inspectHextension,
  uniqueExtensionFolderName,
  unpackEngineExtensionZip,
  type ExtensionDescriptor,
  type InspectedHextension,
} from "@haptic/assets";
import { newGuid, type ProjectStorage } from "@haptic/core";
import {
  createReadOnlyProjectStorage,
  createTemplateStorage,
  ENGINE_EXTENSION_LIBRARY_FOLDER,
  MemoryStorageAdapter,
} from "@haptic/vfs";
import {
  captureLibraryFile, createLibraryQueue, LIBRARY_DEFAULTS_FILE, readLibraryDefaults,
  resolveLibraryImport, restoreLibraryFiles, sameLibraryIdentity, writeLibraryDefaults,
} from "./engine-library";
import { ensureEngineExtensionStorage } from "./engine-extensions";

export const ENGINE_EXTENSION_LIBRARY_ROOT = ENGINE_EXTENSION_LIBRARY_FOLDER;

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

const extensionGuidOf = (entry: EngineExtensionEntry) => entry.extensionGuid;

/** App-owned extension archives and creation defaults, separate from project copies. */
export class EngineExtensionLibrary {
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

  private async readState(): Promise<LibraryState> {
    const defaults = await readLibraryDefaults(this.libraryStorage);
    const entries: EngineExtensionEntry[] = [];
    const archivePaths = new Map<string, string>();
    const folderNames: string[] = [];
    const append = (descriptor: ExtensionDescriptor, bundled: boolean) => {
      const enabledByDefault = descriptor.invalid ? false :
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
      .filter((file) => !file.isDir && file.name.endsWith(".hextension"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const archive of archives) {
      let incoming: InspectedHextension;
      try {
        incoming = await inspectHextension(await this.libraryStorage.readBinary(archive.name));
      } catch (cause) {
        const guid = `invalid-library:${encodeURIComponent(archive.name)}`;
        const folderName = uniqueExtensionFolderName(archive.name, folderNames);
        const entry = append({
          extensionGuid: guid,
          folderName,
          folderPath: folderName,
          settingsPath: `${folderName}/extension.json`,
          contentPath: `${folderName}/assets`,
          source: "engine",
          readOnly: true,
          settings: createExtensionSettings(`Invalid Extension (${archive.name})`, guid),
          invalid: cause instanceof Error ? cause.message : String(cause),
        }, false);
        archivePaths.set(entry.extensionGuid, archive.name);
        continue;
      }
      // An engine update may introduce a bundled name/GUID already in the library.
      // The bundled original remains authoritative; never let a user archive replace it.
      if (sameLibraryIdentity(entries, extensionGuidOf, incoming.settings.extensionGuid, incoming.settings.displayName).length > 0) {
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
    for (const entry of state.entries.filter((value) => !value.invalid)) {
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
      if (entry.invalid) throw new Error(`The Engine Extension is invalid: ${entry.invalid}`);
      const storage = await this.captureStorage({ ...state, entries: [entry] });
      return exportExtensionZip(storage, entry);
    });
  }

  setEnabledByDefault(guid: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const { entries, defaults } = await this.readState();
      const entry = entries.find((entry) => entry.extensionGuid === guid);
      if (!entry) {
        throw new Error("The Engine Extension no longer exists.");
      }
      if (entry.invalid) throw new Error(`The Engine Extension is invalid: ${entry.invalid}`);
      defaults[guid] = enabled;
      await writeLibraryDefaults(this.libraryStorage, defaults);
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
      await writeLibraryDefaults(this.libraryStorage, defaults);
    });
  }

  import(
    bytes: Uint8Array,
    options: { replaceGuid?: string } = {},
  ): Promise<EngineExtensionImportResult> {
    return this.serialize(async () => {
      const incoming = await inspectHextension(bytes);
      const { entries, archivePaths, defaults } = await this.readState();
      const target = resolveLibraryImport(entries, extensionGuidOf, {
        guid: incoming.settings.extensionGuid, displayName: incoming.settings.displayName,
      }, options.replaceGuid, "Extension");
      if ("conflict" in target) return { status: "conflict", existing: target.conflict };
      const { existing } = target;
      const archivePath = existing
        ? archivePaths.get(existing.extensionGuid)!
        : `${newGuid()}.hextension`;
      const previousArchive = existing ? await this.libraryStorage.readBinary(archivePath) : null;
      const previousDefaults = await captureLibraryFile(this.libraryStorage, LIBRARY_DEFAULTS_FILE);
      if (existing) {
        delete defaults[existing.extensionGuid];
        defaults[incoming.settings.extensionGuid] = existing.enabledByDefault;
      }
      try {
        await this.libraryStorage.writeBinary(archivePath, bytes);
        await writeLibraryDefaults(this.libraryStorage, defaults);
        const entry = (await this.readState()).entries.find(
          (extension) => extension.extensionGuid === incoming.settings.extensionGuid,
        );
        if (!entry) throw new Error("Export did not produce an Engine Extension.");
        return { status: "imported", entry };
      } catch (cause) {
        return restoreLibraryFiles(this.libraryStorage,
          [[archivePath, previousArchive], [LIBRARY_DEFAULTS_FILE, previousDefaults]], cause, "Extension");
      }
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
