import { ENGINE_VERSION, type ExtensionGameLibrary, type ProjectStorage } from "@haptic/core";
import {
  applyExtensionImport, createExtensionSettings, discoverEngineExtensions,
  discoverProjectExtensions, encodeExtensionSettings, exportExtensionZip,
  EXTENSION_CODE_DIR, EXTENSION_SOURCE_MAX_BYTES, inspectHextension, isExtensionCodePath,
  isExtensionPackagePath, normalizeExtensionSettings,
  planExtensionImport, readExtensionCodeFiles, resolveExtensionGraph, shadowEngineExtensions,
  uniqueExtensionFolderName, writeProjectExtension,
  type ExtensionCodeFile, type ExtensionDescriptor, type ExtensionSettings,
} from "@haptic/assets";
import { EditorExtensionHost, type EditorExtensionServices, type EditorExtensionCommandDescriptor } from "../lib/editor-extension-host";
import { linkExtensionModules } from "../lib/extension-modules";
import { resolvedExtensionSettings, type ExtensionSettingValues } from "../lib/extension-settings-ui";

/** Code file edits applied by one Save. */
export interface ExtensionFileChanges {
  /** Entry, game entry or `code/` files to create or replace. */
  write: readonly ExtensionCodeFile[];
  /** `code/` files to delete. */
  remove: readonly string[];
}

/** Enabled, valid gameplay (not Editor Only) packages of a resolved order, keeping its dependency order. */
export function gameplayExtensions(order: readonly ExtensionDescriptor[]): ExtensionDescriptor[] {
  return order.filter((entry) => !entry.invalid && !entry.settings.editorOnly);
}

/** Two enabled gameplay packages claiming one Library Name cannot both reach games. */
function duplicateLibraryDiagnostics(order: readonly ExtensionDescriptor[]): string[] {
  const owners = new Map<string, string[]>();
  for (const entry of gameplayExtensions(order)) {
    owners.set(entry.settings.libraryName, [...owners.get(entry.settings.libraryName) ?? [], entry.settings.displayName]);
  }
  return [...owners].filter(([, names]) => names.length > 1)
    .map(([library, names]) => `Library Name ${library} is used by ${names.join(", ")}.`);
}

export type ExtensionOverrides = Record<string, { enabled: boolean }>;

export interface ExtensionSnapshot {
  entries: ExtensionDescriptor[];
  commands: EditorExtensionCommandDescriptor[];
  diagnostics: string[];
}

export interface EditorExtensionWriteOptions {
  /** Project owner admission spans queued package operations and guest writes. */
  runAuthoringWrite?: <T>(operation: () => Promise<T>) => Promise<T>;
  /**
   * Mounts exactly these gameplay packages' `assets/` roots (dependencies first)
   * and unmounts every other extension root. Called when that set changes and
   * before a package's files are replaced or deleted.
   */
  syncContentRoots?: (extensions: readonly ExtensionDescriptor[]) => Promise<void>;
}

/** A project lifetime owns code activation and the content roots of its gameplay packages. */
export class EditorExtensionService {
  private readonly storage: ProjectStorage;
  private engineStorage: ProjectStorage | null = null;
  private host: EditorExtensionHost;
  private overrides: ExtensionOverrides = {};
  private settingValues: ExtensionSettingValues = {};
  private listeners = new Set<() => void>();
  private state: ExtensionSnapshot = { entries: [], commands: [], diagnostics: [] };
  private fingerprint = "";
  /** Extensions active in the current host, which the fingerprint describes. */
  private started = new Set<string>();
  private mutation: Promise<unknown> = Promise.resolve();
  private writeGuard: (path: string) => void = () => {};
  private readonly services: EditorExtensionServices;
  private cleanupDiagnostics: string[] = [];
  private packageDiagnostics: string[] = [];
  private unsubscribeHost: () => void = () => {};
  /** Enabled packages of the last refresh, dependencies first. */
  private order: ExtensionDescriptor[] = [];
  private readonly runAuthoringWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  private readonly syncRoots: (extensions: readonly ExtensionDescriptor[]) => Promise<void>;
  /** The gameplay packages whose roots were last synced. */
  private contentRootsKey = "[]";

  constructor(storage: ProjectStorage, services: EditorExtensionServices, options: EditorExtensionWriteOptions = {}) {
    this.storage = storage;
    this.runAuthoringWrite = options.runAuthoringWrite ?? (operation => operation());
    this.syncRoots = options.syncContentRoots ?? (async () => {});
    this.services = {
      ...services,
      assets: {
        ...services.assets,
        create: (path, document) => this.runAuthoringWrite(() => services.assets.create(path, document)),
        update: (path, document) => {
          this.writeGuard(path);
          return this.runAuthoringWrite(() => services.assets.update(path, document));
        },
      },
      code: {
        ...services.code,
        write: (path, source) => this.runAuthoringWrite(() => services.code.write(path, source)),
      },
    };
    this.host = this.createHost();
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
  private createHost(): EditorExtensionHost {
    const host = new EditorExtensionHost(this.services);
    this.unsubscribeHost = host.subscribe(() => this.publishHostState());
    return host;
  }
  private publishHostState(entries = this.state.entries): void {
    this.publish({ entries, commands: this.host.listCommands(), diagnostics: [
      ...this.packageDiagnostics, ...this.cleanupDiagnostics, ...this.host.getDiagnostics().map((value) => value.message),
    ] });
  }
  private async resetHost(): Promise<void> {
    this.unsubscribeHost();
    await this.host.dispose();
    for (const diagnostic of this.host.getDiagnostics().filter((value) => value.phase === "dispose")) {
      const name = this.state.entries.find((entry) => entry.extensionGuid === diagnostic.extensionId)?.settings.displayName ?? diagnostic.extensionId;
      const message = `${name}: cleanup failed: ${diagnostic.message}`;
      this.cleanupDiagnostics.push(message);
      this.services.log?.(diagnostic.extensionId, message);
    }
    this.cleanupDiagnostics = this.cleanupDiagnostics.slice(-50);
    this.host = this.createHost();
    this.started = new Set();
  }
  private async syncContentRoots(extensions: readonly ExtensionDescriptor[]): Promise<void> {
    const gameplay = gameplayExtensions(extensions);
    const key = JSON.stringify(gameplay.map((entry) => [entry.extensionGuid, entry.source, entry.contentPath]));
    if (key === this.contentRootsKey) return;
    this.contentRootsKey = key;
    await this.syncRoots(gameplay);
  }
  /** Unmounts a package's root before its files are replaced or deleted. */
  private async releaseContentRoot(guid: string): Promise<void> {
    if (!this.order.some((entry) => entry.extensionGuid === guid && !entry.settings.editorOnly)) return;
    await this.syncContentRoots(this.order.filter((entry) => entry.extensionGuid !== guid));
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
      const diagnostics = [...graph.diagnostics.map((value) => value.message), ...duplicateLibraryDiagnostics(graph.order)];
      const modules: { entry: ExtensionDescriptor; files: ExtensionCodeFile[] }[] = [];
      for (const entry of graph.order) {
        try {
          modules.push({ entry, files: await readExtensionCodeFiles(this.storageFor(entry), entry.folderPath) });
        } catch (cause) {
          diagnostics.push(`${entry.settings.displayName}: ${String(cause)}`);
        }
      }
      this.order = graph.order;
      await this.syncContentRoots(graph.order);
      const fingerprint = JSON.stringify([entries, modules, overrides]);
      if (fingerprint !== this.fingerprint) {
        await this.resetHost();
        this.fingerprint = fingerprint;
      }
      // Unchanged packages keep running; only those that did not start are retried.
      for (const { entry, files } of modules) {
        if (this.started.has(entry.extensionGuid)) continue;
        if (entry.settings.extensionDependencies.some((dependency) => !this.started.has(dependency.guid))) {
          diagnostics.push(`${entry.settings.displayName}: a required Extension failed to start.`);
          continue;
        }
        if (await this.host.activate({
          id: entry.extensionGuid, label: entry.settings.displayName, entry: entry.settings.entryPoint, files,
          settings: resolvedExtensionSettings(entry, this.settingValues),
        })) this.started.add(entry.extensionGuid);
      }
      this.packageDiagnostics = diagnostics;
      this.publishHostState(entries);
    } catch (cause) {
      await this.resetHost();
      this.fingerprint = "";
      this.order = [];
      await this.syncContentRoots([]).catch(() => undefined);
      this.packageDiagnostics = [String(cause)];
      this.publishHostState([]);
      throw cause;
    }
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      await this.resetHost();
      this.fingerprint = "";
      this.overrides = {};
      this.cleanupDiagnostics = [];
      this.packageDiagnostics = [];
      this.order = [];
      await this.syncContentRoots([]);
      this.publishHostState([]);
    });
  }

  create(name: string): Promise<ExtensionDescriptor> {
    return this.runAuthoringWrite(() => this.serialize(async () => {
      const existing = await discoverProjectExtensions(this.storage);
      const result = await writeProjectExtension(this.storage,
        uniqueExtensionFolderName(name, existing.map((entry) => entry.folderName)), createExtensionSettings(name));
      await this.refreshNow(this.overrides);
      return result;
    }));
  }

  /** The package's code files: its entries and everything under `code/`. */
  readFiles(guid: string): Promise<ExtensionCodeFile[]> {
    const entry = this.entry(guid);
    if (entry.invalid) throw new Error(entry.invalid);
    return readExtensionCodeFiles(this.storageFor(entry), entry.folderPath);
  }

  save(guid: string, settings: ExtensionSettings, changes: ExtensionFileChanges): Promise<void> {
    return this.runAuthoringWrite(() => this.serialize(async () => {
      const entry = this.entry(guid);
      if (entry.invalid) throw new Error(entry.invalid);
      if (entry.readOnly) throw new Error("Engine Extensions are read-only. Import a project copy to edit it.");
      if (settings.extensionGuid !== guid || settings.entryPoint !== entry.settings.entryPoint
        || settings.gameEntryPoint !== entry.settings.gameEntryPoint) {
        throw new Error("Extension identity and Entry Points cannot change while editing.");
      }
      const entries = new Set([entry.settings.entryPoint, entry.settings.gameEntryPoint]);
      const touched = [...new Set([...changes.write.map((file) => file.path), ...changes.remove])];
      const previous = new Map<string, string | null>();
      for (const path of touched) {
        if (!isExtensionCodePath(path)) throw new Error(`Extension code files are .ts or .js files outside assets/: ${path}`);
        const full = `${entry.folderPath}/${path}`;
        previous.set(path, await this.storage.exists(full) ? await this.storage.readText(full) : null);
      }
      // New files go in code/ so the package stays tidy; existing files keep their place.
      for (const file of changes.write) {
        if (previous.get(file.path) === null && !entries.has(file.path) && !file.path.startsWith(`${EXTENSION_CODE_DIR}/`)) {
          throw new Error(`New Extension code files go in ${EXTENSION_CODE_DIR}/: ${file.path}`);
        }
        if (new TextEncoder().encode(file.source).byteLength > EXTENSION_SOURCE_MAX_BYTES) {
          throw new Error(`Extension code file exceeds 1 MiB: ${file.path}`);
        }
      }
      if (changes.remove.some((path) => entries.has(path))) throw new Error("An Extension's entry files cannot be removed.");
      const gameEntryWritten = changes.write.some((file) => file.path === entry.settings.gameEntryPoint);
      if (!settings.editorOnly && !gameEntryWritten
        && !(await this.storage.exists(`${entry.folderPath}/${entry.settings.gameEntryPoint}`))) {
        throw new Error(`A gameplay Extension needs its game entry: ${entry.settings.gameEntryPoint}`);
      }
      const previousManifest = await this.storage.readBinary(entry.settingsPath);
      const authored = settings.version !== entry.settings.version || changes.remove.length > 0
        || changes.write.some((file) => previous.get(file.path) !== file.source);
      const normalized = normalizeExtensionSettings({ ...settings,
        engineVersion: authored ? ENGINE_VERSION : entry.settings.engineVersion,
        extensionDependencies: settings.extensionDependencies.map((dependency) => ({ ...dependency,
          version: authored ? this.state.entries.find((value) => value.extensionGuid === dependency.guid)?.settings.version ?? dependency.version : dependency.version,
        })),
      });
      try {
        for (const file of changes.write) {
          const full = `${entry.folderPath}/${file.path}`;
          await this.storage.mkdir(full.slice(0, full.lastIndexOf("/")), true);
          await this.storage.writeText(full, file.source);
        }
        for (const path of changes.remove) {
          if (previous.get(path) !== null) await this.storage.remove(`${entry.folderPath}/${path}`);
        }
        await this.storage.writeBinary(entry.settingsPath, encodeExtensionSettings(normalized));
      } catch (cause) {
        for (const [path, source] of previous) {
          const full = `${entry.folderPath}/${path}`;
          if (source === null) { if (await this.storage.exists(full)) await this.storage.remove(full); }
          else await this.storage.writeText(full, source);
        }
        await this.storage.writeBinary(entry.settingsPath, previousManifest);
        throw cause;
      }
      this.fingerprint = "";
      await this.refreshNow(this.overrides);
    }));
  }

  /**
   * Links the game module of every enabled gameplay package, dependencies first,
   * reading current files so edits made in another editor are picked up.
   */
  gameLibraries(overrides: ExtensionOverrides = this.overrides, settingValues: ExtensionSettingValues = this.settingValues): Promise<ExtensionGameLibrary[]> {
    return this.serialize(async () => {
      const entries = shadowEngineExtensions(
        await discoverProjectExtensions(this.storage),
        this.engineStorage ? await discoverEngineExtensions(this.engineStorage) : [],
      );
      const order = resolveExtensionGraph(entries, ENGINE_VERSION, overrides).order;
      const duplicates = duplicateLibraryDiagnostics(order);
      if (duplicates.length > 0) throw new Error(duplicates.join("\n"));
      const libraries: ExtensionGameLibrary[] = [];
      for (const entry of gameplayExtensions(order)) {
        try {
          const files = await readExtensionCodeFiles(this.storageFor(entry), entry.folderPath);
          libraries.push({
            extensionGuid: entry.extensionGuid,
            libraryName: entry.settings.libraryName,
            label: entry.settings.displayName,
            settings: resolvedExtensionSettings(entry, settingValues),
            bundle: await linkExtensionModules(files, entry.settings.gameEntryPoint),
          });
        } catch (cause) {
          throw new Error(`Extension ${entry.settings.displayName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
      }
      return libraries;
    });
  }

  /** Enabled gameplay packages of the last refresh, dependencies first. */
  getGameplayExtensions(): ExtensionDescriptor[] {
    return gameplayExtensions(this.order);
  }

  remove(guid: string): Promise<void> {
    return this.runAuthoringWrite(() => this.serialize(async () => {
      const entry = this.entry(guid);
      if (entry.readOnly || !entry.folderPath.startsWith("extensions/") || !isExtensionPackagePath(entry.folderPath)) {
        throw new Error("Only project Extensions can be deleted here.");
      }
      await this.resetHost();
      this.fingerprint = "";
      await this.releaseContentRoot(guid);
      try {
        await this.storage.remove(entry.folderPath);
      } catch (cause) {
        await this.refreshNow(this.overrides);
        throw cause;
      }
      const next = { ...this.overrides };
      delete next[guid];
      await this.refreshNow(next);
    }));
  }

  export(guid: string): Promise<Uint8Array> {
    return this.serialize(async () => {
      const entry = this.entry(guid);
      if (entry.invalid) throw new Error(entry.invalid);
      return exportExtensionZip(this.storageFor(entry), entry);
    });
  }

  import(bytes: Uint8Array, replace = false): Promise<{ status: "imported" } | { status: "conflict"; name: string }> {
    return this.runAuthoringWrite(() => this.serialize(async () => {
      const incoming = await inspectHextension(bytes);
      const existing = await discoverProjectExtensions(this.storage);
      const plan = planExtensionImport({ incoming, existingExtensions: existing,
        existingFolderNames: existing.map((entry) => entry.folderName), occupiedGuids: new Set(existing.map((entry) => entry.extensionGuid)) });
      // Every replacement of executable code is confirmed, including version changes.
      if ((plan.kind === "conflict" || plan.kind === "update") && !replace) {
        return { status: "conflict", name: incoming.settings.displayName };
      }
      await this.resetHost();
      this.fingerprint = "";
      if (plan.kind === "update" || plan.kind === "conflict") await this.releaseContentRoot(plan.existingGuid);
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
    }));
  }

  getOverrides(): ExtensionOverrides { return { ...this.overrides }; }

  /**
   * The project's stored settings values. Running extensions see their
   * resolved values through `api.settings`; nothing restarts.
   */
  setSettingValues(values: ExtensionSettingValues): void {
    this.settingValues = values;
    for (const entry of this.state.entries) {
      if (this.started.has(entry.extensionGuid)) this.host.updateSettings(entry.extensionGuid, resolvedExtensionSettings(entry, values));
    }
  }

  /** Runs a command; resolves to the message it returned, if any. */
  run(extensionId: string, commandId: string, values: Readonly<Record<string, unknown>>): Promise<string | undefined> {
    return this.serialize(() => this.host.run(extensionId, commandId, values));
  }
}
