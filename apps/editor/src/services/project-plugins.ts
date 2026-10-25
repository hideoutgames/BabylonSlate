import type { PluginEnableOverride, ProjectStorage } from "@haptic/core";
import {
  AssetRegistry,
  applyPluginImport,
  createDefaultPluginSettings,
  discoverEnginePlugins,
  discoverProjectPlugins,
  exportPluginZip,
  indexUnresolvedPlaceholders,
  inspectHplugin,
  installEngineExtensionDefaults,
  installEnginePluginDefaults,
  mountEnabledPlugins,
  planPluginImport,
  resolvePluginEnabled,
  resolvePluginGraph,
  shadowEnginePlugins,
  writeProjectPlugin,
  type BlobStore,
  type IndexedAsset,
  type InspectedHplugin,
  type PluginDescriptor,
  type PluginDiagnostic,
  type PluginImportPlan,
} from "@haptic/assets";
import { pluginRootId, uniquePluginFolderName } from "../lib/plugin-ui";
import { newGuid } from "./project-document-meta";

export type PluginImportResult =
  | { status: "imported"; descriptor: PluginDescriptor }
  | { status: "kept" }
  | {
      status: "conflict";
      incoming: InspectedHplugin;
      plan: Extract<PluginImportPlan, { kind: "conflict" }>;
    };

/** What plugin discovery and mounting read from the project session that owns it. */
export interface ProjectPluginsHost {
  readonly storage: ProjectStorage;
  readonly blobs: BlobStore;
  registry(): AssetRegistry | null;
  emitRegistryChange(): void;
}

/**
 * The open project's plugins: project and engine plugin folders, which of
 * them are enabled and mounted in the registry, and their dependency graph.
 */
export class ProjectPlugins {
  private enginePluginStorage: ProjectStorage | null = null;
  private engineExtensionStorage: ProjectStorage | null = null;
  private pluginDescriptors: PluginDescriptor[] = [];
  /** Plugin folders change only through a full sync; overrides reuse the last discovery. */
  private pluginDescriptorsCurrent = false;
  private pluginDiagnostics: PluginDiagnostic[] = [];
  private pluginOverrides: Record<string, PluginEnableOverride> = {};

  private readonly host: ProjectPluginsHost;

  constructor(host: ProjectPluginsHost) {
    this.host = host;
  }

  get descriptors(): PluginDescriptor[] {
    return this.pluginDescriptors;
  }

  get diagnostics(): PluginDiagnostic[] {
    return this.pluginDiagnostics;
  }

  get engineStorage(): ProjectStorage | null {
    return this.enginePluginStorage;
  }

  /** Close Project forgets the closed project's plugins. */
  reset(): void {
    this.pluginDescriptors = [];
    this.pluginDescriptorsCurrent = false;
    this.pluginDiagnostics = [];
    this.pluginOverrides = {};
  }

  /** Export presets scan their selected plugin roots without changing editor mounts. */
  async listExportAssets(
    enabledPluginGuids: ReadonlySet<string>,
  ): Promise<IndexedAsset[]> {
    const exportRegistry = new AssetRegistry(this.host.storage, {
      blobs: this.host.blobs,
    });
    await mountEnabledPlugins(exportRegistry, this.pluginDescriptors, {
      enabledGuids: enabledPluginGuids,
      storageFor: (plugin) =>
        plugin.source === "engine"
          ? (this.enginePluginStorage ?? undefined)
          : undefined,
    });
    const byGuid = new Map(
      (this.host.registry()?.list() ?? [])
        .filter((asset) => !asset.rootId.startsWith("plugin:"))
        .map((asset) => [asset.header.guid, asset]),
    );
    for (const asset of exportRegistry.list())
      byGuid.set(asset.header.guid, asset);
    return [...byGuid.values()];
  }

  setEnginePluginStorage(storage: ProjectStorage | null): void {
    this.enginePluginStorage = storage;
    this.pluginDescriptorsCurrent = false;
  }

  setEngineExtensionStorage(storage: ProjectStorage): void {
    this.engineExtensionStorage = storage;
  }

  async installEnginePluginDefaultsIfNeeded(): Promise<void> {
    if (this.engineExtensionStorage) await installEngineExtensionDefaults(this.host.storage, this.engineExtensionStorage);
    if (!this.enginePluginStorage) return;
    await installEnginePluginDefaults(this.host.storage, this.enginePluginStorage);
  }

  setOverrides(
    overrides: Record<string, PluginEnableOverride>,
  ): void {
    this.pluginOverrides = overrides;
  }

  async sync(options: { rediscover?: boolean } = {}): Promise<void> {
    const registry = this.host.registry();
    if (!registry) return;
    if (options.rediscover !== false || !this.pluginDescriptorsCurrent) {
      const projectPlugins = await discoverProjectPlugins(this.host.storage);
      const enginePlugins = this.enginePluginStorage
        ? await discoverEnginePlugins(this.enginePluginStorage)
        : [];
      this.pluginDescriptors = shadowEnginePlugins(
        projectPlugins,
        enginePlugins,
      );
      this.pluginDescriptorsCurrent = true;
    }
    const enabledGuids = new Set(
      this.pluginDescriptors
        .filter((plugin) =>
          resolvePluginEnabled(
            plugin.settings.enabledByDefault,
            this.pluginOverrides[plugin.pluginGuid]?.enabled,
          ),
        )
        .map((plugin) => plugin.pluginGuid),
    );
    for (const plugin of this.pluginDescriptors) {
      const rootId = pluginRootId(plugin.pluginGuid);
      if (!enabledGuids.has(plugin.pluginGuid) && registry.getRoot(rootId)) {
        registry.unmountRoot(rootId);
      }
    }
    await mountEnabledPlugins(registry, this.pluginDescriptors, {
      enabledGuids,
      storageFor: (plugin) =>
        plugin.source === "engine"
          ? (this.enginePluginStorage ?? undefined)
          : undefined,
    });
    const { diagnostics } = resolvePluginGraph(
      this.pluginDescriptors.filter((plugin) => enabledGuids.has(plugin.pluginGuid)),
    );
    this.pluginDiagnostics = diagnostics;
    const discoveredGuids = new Set(
      this.pluginDescriptors.map((plugin) => plugin.pluginGuid),
    );
    indexUnresolvedPlaceholders(registry, {
      expectedGuids: Object.keys(this.pluginOverrides).filter(
        (guid) => !discoveredGuids.has(guid),
      ),
    });
  }

  async applyOverrides(
    overrides: Record<string, PluginEnableOverride>,
  ): Promise<void> {
    this.pluginOverrides = overrides;
    // Toggling a discovered plugin changes mounts, not plugin folders; an
    // unknown guid may name a folder written since the last discovery.
    const known = new Set(this.pluginDescriptors.map((plugin) => plugin.pluginGuid));
    await this.sync({ rediscover: Object.keys(overrides).some((guid) => !known.has(guid)) });
    this.host.emitRegistryChange();
  }

  async create(displayName: string): Promise<PluginDescriptor> {
    const name = displayName.trim() || "Plugin";
    const existing = await discoverProjectPlugins(this.host.storage);
    const folderName = uniquePluginFolderName(
      name,
      existing.map((plugin) => plugin.folderName),
    );
    const settings = createDefaultPluginSettings({
      pluginGuid: newGuid(),
      displayName: name,
    });
    const descriptor = await writeProjectPlugin(
      this.host.storage,
      folderName,
      settings,
    );
    await this.sync();
    this.host.emitRegistryChange();
    return descriptor;
  }

  async delete(guid: string): Promise<void> {
    const plugin = this.pluginDescriptors.find(
      (entry) => entry.pluginGuid === guid,
    );
    if (!plugin) return;
    if (plugin.source === "engine") {
      throw new Error("Engine plugins cannot be deleted from the project");
    }
    this.host.registry()?.unmountRoot(pluginRootId(guid));
    await this.host.storage.remove(plugin.folderPath);
    const next = { ...this.pluginOverrides };
    delete next[guid];
    this.pluginOverrides = next;
    await this.sync();
    this.host.emitRegistryChange();
  }

  async export(guid: string): Promise<Uint8Array> {
    const plugin = this.pluginDescriptors.find(
      (entry) => entry.pluginGuid === guid,
    );
    if (!plugin) {
      throw new Error(`Unknown plugin ${guid}`);
    }
    const storage =
      plugin.source === "engine"
        ? this.enginePluginStorage
        : this.host.storage;
    if (!storage) {
      throw new Error("Plugin storage is not available");
    }
    return exportPluginZip(storage, plugin);
  }

  async import(
    bytes: Uint8Array,
    decision?: "keep" | "replace",
  ): Promise<PluginImportResult> {
    const incoming = await inspectHplugin(bytes);
    const plan = planPluginImport({
      incoming,
      existingPlugins: this.pluginDescriptors,
      indexedAssets: this.host.registry()?.list() ?? [],
      existingFolderNames: this.pluginDescriptors.map(
        (plugin) => plugin.folderName,
      ),
    });
    if (plan.kind === "conflict") {
      if (decision === "keep") return { status: "kept" };
      if (decision !== "replace") {
        return { status: "conflict", incoming, plan };
      }
      await applyPluginImport(this.host.storage, incoming, {
        ...plan,
        replace: true,
      });
    } else {
      await applyPluginImport(this.host.storage, incoming, plan);
    }
    await this.sync();
    this.host.emitRegistryChange();
    const guid =
      plan.kind === "remap-plugin" ? plan.nextGuid : incoming.settings.pluginGuid;
    const descriptor = this.pluginDescriptors.find(
      (plugin) => plugin.pluginGuid === guid,
    );
    if (!descriptor) {
      throw new Error("Plugin import did not produce a descriptor");
    }
    return { status: "imported", descriptor };
  }

  forPath(path: string): PluginDescriptor | undefined {
    return this.pluginDescriptors.find(
      (entry) =>
        path === entry.settingsPath ||
        path.startsWith(`${entry.folderPath}/`),
    );
  }
}
