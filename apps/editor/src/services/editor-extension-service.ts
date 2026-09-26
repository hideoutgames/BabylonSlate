import { ENGINE_VERSION, type ProjectStorage } from "@babylonslate/core";
import {
  applyExtensionImport, createExtensionSettings, discoverEngineExtensions,
  discoverProjectExtensions, encodeExtensionSettings, exportExtensionZip,
  inspectBabextension, isExtensionPackagePath, normalizeExtensionSettings,
  planExtensionImport, resolveExtensionGraph, shadowEngineExtensions,
  uniqueExtensionFolderName, writeProjectExtension,
  type ExtensionDescriptor, type ExtensionSettings,
} from "@babylonslate/assets";
import { EditorExtensionHost, type EditorExtensionServices, type EditorExtensionCommandDescriptor } from "../lib/editor-extension-host";

export type ExtensionOverrides = Record<string, { enabled: boolean }>;
export interface ExtensionSnapshot {
  entries: ExtensionDescriptor[];
  commands: EditorExtensionCommandDescriptor[];
  diagnostics: string[];
}

/** A project lifetime owns code activation; extension files never mount as game assets. */
export class EditorExtensionService {
  private readonly storage: ProjectStorage;
  private engineStorage: ProjectStorage | null = null;
  private host: EditorExtensionHost;
  private overrides: ExtensionOverrides = {};
  private listeners = new Set<() => void>();
  private state: ExtensionSnapshot = { entries: [], commands: [], diagnostics: [] };
  private fingerprint = "";
  private mutation: Promise<unknown> = Promise.resolve();
  private writeGuard: (path: string) => void = () => {};
  private readonly services: EditorExtensionServices;

  constructor(storage: ProjectStorage, services: EditorExtensionServices) {
    this.storage = storage;
    this.services = {
      ...services,
      assets: {
        ...services.assets,
        update: (path, document) => {
          this.writeGuard(path);
          return services.assets.update(path, document);
        },
      },
    };
    this.host = new EditorExtensionHost(this.services);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): ExtensionSnapshot => this.state;
  setEngineStorage(storage: ProjectStorage): void { this.engineStorage = storage; }
  setAssetWriteGuard(guard: (path: string) => void): void { this.writeGuard = guard; }

  private publish(next: Partial<ExtensionSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }
  private async resetHost(): Promise<void> {
    await this.host.dispose();
    this.host = new EditorExtensionHost(this.services);
  }
  private storageFor(entry: ExtensionDescriptor): ProjectStorage {
    const storage = entry.source === "engine" ? this.engineStorage : this.storage;
    if (!storage) throw new Error("Extension storage is unavailable.");
    return storage;
  }
  private entry(guid: string): ExtensionDescriptor {
    const entry = this.state.entries.find((value) => value.extensionGuid === guid);
    if (!entry) throw new Error("The Extension no longer exists.");
    return entry;
  }

  refresh(overrides = this.overrides): Promise<void> {
    return this.serialize(() => this.refreshNow(overrides));
  }
  private async refreshNow(overrides: ExtensionOverrides): Promise<void> {
    this.overrides = { ...overrides };
    try {
      const entries = shadowEngineExtensions(
        await discoverProjectExtensions(this.storage),
        this.engineStorage ? await discoverEngineExtensions(this.engineStorage) : [],
      );
      const graph = resolveExtensionGraph(entries, ENGINE_VERSION, overrides);
      const diagnostics = graph.diagnostics.map((value) => value.message);
      const modules = [];
      for (const entry of graph.order) {
        const path = `${entry.folderPath}/${entry.settings.entryPoint}`;
        try {
          modules.push({ entry, path, source: await this.storageFor(entry).readText(path) });
        } catch (cause) {
          diagnostics.push(`${entry.settings.displayName}: ${String(cause)}`);
        }
      }
      const fingerprint = JSON.stringify([entries, modules, overrides]);
      if (fingerprint !== this.fingerprint) {
        await this.resetHost();
        const active = new Set<string>();
        for (const { entry, path, source } of modules) {
          if (entry.settings.extensionDependencies.some((dependency) => !active.has(dependency.guid))) {
            diagnostics.push(`${entry.settings.displayName}: a required Extension failed to start.`);
            continue;
          }
          if (await this.host.activate({ id: entry.extensionGuid, path, source })) active.add(entry.extensionGuid);
        }
        this.fingerprint = active.size === graph.order.length ? fingerprint : "";
      }
      this.publish({ entries, commands: this.host.listCommands(), diagnostics: [
        ...diagnostics, ...this.host.getDiagnostics().map((value) => value.message),
      ] });
    } catch (cause) {
      await this.resetHost();
      this.fingerprint = "";
      this.publish({ entries: [], commands: [], diagnostics: [String(cause)] });
      throw cause;
    }
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      await this.resetHost();
      this.fingerprint = "";
      this.overrides = {};
      this.publish({ entries: [], commands: [], diagnostics: [] });
    });
  }

  create(name: string): Promise<ExtensionDescriptor> {
    return this.serialize(async () => {
      const existing = await discoverProjectExtensions(this.storage);
      const result = await writeProjectExtension(this.storage,
        uniqueExtensionFolderName(name, existing.map((entry) => entry.folderName)), createExtensionSettings(name));
      await this.refreshNow(this.overrides);
      return result;
    });
  }

  readSource(guid: string): Promise<string> {
    const entry = this.entry(guid);
    return this.storageFor(entry).readText(`${entry.folderPath}/${entry.settings.entryPoint}`);
  }

  save(guid: string, settings: ExtensionSettings, source: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.entry(guid);
      if (entry.readOnly) throw new Error("Engine Extensions are read-only. Import a project copy to edit it.");
      if (settings.extensionGuid !== guid || settings.entryPoint !== entry.settings.entryPoint) {
        throw new Error("Extension identity and Entry Point cannot change while editing.");
      }
      const path = `${entry.folderPath}/${entry.settings.entryPoint}`;
      const previousSource = await this.storage.readText(path);
      const previousManifest = await this.storage.readBinary(entry.settingsPath);
      const authored = source !== previousSource || settings.version !== entry.settings.version;
      const normalized = normalizeExtensionSettings({ ...settings,
        engineVersion: authored ? ENGINE_VERSION : entry.settings.engineVersion,
        extensionDependencies: settings.extensionDependencies.map((dependency) => ({ ...dependency,
          version: authored ? this.state.entries.find((value) => value.extensionGuid === dependency.guid)?.settings.version ?? dependency.version : dependency.version,
        })),
      });
      try {
        await this.storage.writeText(path, source);
        await this.storage.writeBinary(entry.settingsPath, encodeExtensionSettings(normalized));
      } catch (cause) {
        await this.storage.writeText(path, previousSource);
        await this.storage.writeBinary(entry.settingsPath, previousManifest);
        throw cause;
      }
      this.fingerprint = "";
      await this.refreshNow(this.overrides);
    });
  }

  remove(guid: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.entry(guid);
      if (entry.readOnly || !entry.folderPath.startsWith("extensions/") || !isExtensionPackagePath(entry.folderPath)) {
        throw new Error("Only project Extensions can be deleted here.");
      }
      await this.resetHost();
      this.fingerprint = "";
      try {
        await this.storage.remove(entry.folderPath);
      } catch (cause) {
        await this.refreshNow(this.overrides);
        throw cause;
      }
      const next = { ...this.overrides };
      delete next[guid];
      await this.refreshNow(next);
    });
  }

  export(guid: string): Promise<Uint8Array> {
    return this.serialize(async () => {
      const entry = this.entry(guid);
      return exportExtensionZip(this.storageFor(entry), entry);
    });
  }

  import(bytes: Uint8Array, replace = false): Promise<{ status: "imported" } | { status: "conflict"; name: string }> {
    return this.serialize(async () => {
      const incoming = await inspectBabextension(bytes);
      const existing = await discoverProjectExtensions(this.storage);
      const plan = planExtensionImport({ incoming, existingExtensions: existing,
        existingFolderNames: existing.map((entry) => entry.folderName), occupiedGuids: new Set(existing.map((entry) => entry.extensionGuid)) });
      // Every replacement of executable code is confirmed, including version changes.
      if ((plan.kind === "conflict" || plan.kind === "update") && !replace) {
        return { status: "conflict", name: incoming.settings.displayName };
      }
      await this.resetHost();
      this.fingerprint = "";
      try {
        await applyExtensionImport(this.storage, incoming, plan.kind === "conflict" ? { ...plan, replace: true } : plan);
      } catch (cause) {
        await this.refreshNow(this.overrides);
        throw cause;
      }
      // Imports do not execute code until explicitly enabled, even when the archive default is on.
      this.overrides = { ...this.overrides, [incoming.settings.extensionGuid]: { enabled: false } };
      await this.refreshNow(this.overrides);
      return { status: "imported" };
    });
  }

  getOverrides(): ExtensionOverrides { return { ...this.overrides }; }

  run(extensionId: string, commandId: string, values: Record<string, string>): Promise<void> {
    return this.serialize(async () => {
      await this.host.run(extensionId, commandId, values);
    });
  }
}
