import { ENGINE_VERSION, type PluginEnableOverride, type ProjectStorage } from "@babylonslate/core";
import { decodeAssetDocument } from "./asset-document";
import { readBabassetHeader } from "./babasset";
import { ASSETS_DIR, PLUGINS_DIR } from "./babproject";
import { pluginContentRoot } from "./content-root";
import {
  encodePluginSettingsDocument,
  normalizePluginSettings,
  PLUGIN_FILE_SUFFIX,
  PLUGIN_SETTINGS_TYPE,
  type PluginSettingsPayload,
} from "./plugin-settings";
import type { AssetRegistry, IndexedAsset } from "./registry";

export type PluginSource = "project" | "engine";

export type PluginDiagnosticCode =
  | "plugin.cycle"
  | "plugin.unsatisfiable"
  | "plugin.dependency_blocked"
  | "plugin.missing"
  | "plugin.engine_unsatisfiable";

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  severity: "warning" | "error";
  message: string;
  pluginGuid?: string;
  plugins?: string[];
  dependencyGuid?: string;
  recordedVersion?: string;
  foundVersion?: string;
}

export interface PluginDescriptor {
  pluginGuid: string;
  folderName: string;
  folderPath: string;
  settingsPath: string;
  contentPath: string;
  source: PluginSource;
  readOnly: boolean;
  settings: PluginSettingsPayload;
}

export type PluginGraphInput = Pick<
  PluginDescriptor,
  "pluginGuid" | "settings"
>;

/** Legacy warning acknowledgement, invalidated by any recorded or installed version change. */
export function pluginCompatibilityKey(
  plugin: PluginGraphInput,
  plugins: readonly PluginGraphInput[],
  engineVersion: string = ENGINE_VERSION,
): string {
  return JSON.stringify({
    pluginGuid: plugin.pluginGuid,
    version: plugin.settings.version,
    recordedEngine: plugin.settings.engineVersion,
    engineVersion,
    dependencies: [...plugin.settings.pluginDependencies]
      .sort((a, b) => a.guid.localeCompare(b.guid))
      .map((dependency) => [
        dependency.guid,
        dependency.version,
        plugins.find((entry) => entry.pluginGuid === dependency.guid)?.settings.version ?? null,
      ]),
  });
}

export function pluginCompatibilityDiagnostics(
  plugin: PluginGraphInput,
  plugins: readonly PluginGraphInput[],
  engineVersion: string = ENGINE_VERSION,
): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  if (engineVersion !== plugin.settings.engineVersion) {
    diagnostics.push({
      code: "plugin.engine_unsatisfiable",
      severity: "warning",
      pluginGuid: plugin.pluginGuid,
      recordedVersion: plugin.settings.engineVersion,
      foundVersion: engineVersion,
      message: `${plugin.settings.displayName} was created with engine ${plugin.settings.engineVersion || "Unknown"}; the current engine is ${engineVersion}.`,
    });
  }
  for (const dependency of plugin.settings.pluginDependencies) {
    const found = plugins.find((entry) => entry.pluginGuid === dependency.guid);
    if (!found || found.settings.version === dependency.version) continue;
    diagnostics.push({
      code: "plugin.unsatisfiable",
      severity: "warning",
      pluginGuid: plugin.pluginGuid,
      dependencyGuid: dependency.guid,
      recordedVersion: dependency.version,
      foundVersion: found.settings.version,
      message: `${plugin.settings.displayName} recorded ${found.settings.displayName} version ${dependency.version || "Unknown"}; the installed version is ${found.settings.version}.`,
    });
  }
  return diagnostics;
}

/** Layer 3 (export preset) wins over project override over the plugin default. */
export function resolvePluginEnabled(
  enabledByDefault: boolean,
  projectOverride?: boolean,
  presetOverride?: boolean,
): boolean {
  if (presetOverride !== undefined) return presetOverride;
  if (projectOverride !== undefined) return projectOverride;
  return enabledByDefault;
}

async function findPluginSettingsPath(
  storage: ProjectStorage,
  folderPath: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await storage.readdir(folderPath);
  } catch {
    return null;
  }
  const files = entries.filter(
    (entry) => !entry.isDir && entry.name.endsWith(".babasset"),
  );
  const preferred = files.filter((entry) =>
    entry.name.endsWith(PLUGIN_FILE_SUFFIX),
  );
  const candidates = [
    ...preferred,
    ...files.filter((file) => !preferred.includes(file)),
  ];
  for (const file of candidates) {
    const path = `${folderPath}/${file.name}`;
    try {
      const header = readBabassetHeader(await storage.readBinary(path));
      if (header.type === PLUGIN_SETTINGS_TYPE) return path;
    } catch {
      continue;
    }
  }
  return null;
}

async function describePluginFolder(
  storage: ProjectStorage,
  folderPath: string,
  source: PluginSource,
): Promise<PluginDescriptor | null> {
  const settingsPath = await findPluginSettingsPath(storage, folderPath);
  if (!settingsPath) return null;
  const bytes = await storage.readBinary(settingsPath);
  const document = await decodeAssetDocument(bytes);
  const settings = normalizePluginSettings(document.payload, {
    pluginGuid: document.guid,
    displayName: document.name,
  });
  const folderName = folderPath.includes("/")
    ? folderPath.slice(folderPath.lastIndexOf("/") + 1)
    : folderPath;
  return {
    pluginGuid: document.guid,
    folderName,
    folderPath,
    settingsPath,
    contentPath: `${folderPath}/${ASSETS_DIR}`,
    source,
    readOnly: source === "engine",
    settings,
  };
}

export async function discoverProjectPlugins(
  storage: ProjectStorage,
): Promise<PluginDescriptor[]> {
  let entries;
  try {
    entries = await storage.readdir(PLUGINS_DIR);
  } catch {
    return [];
  }
  const plugins: PluginDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const described = await describePluginFolder(
      storage,
      `${PLUGINS_DIR}/${entry.name}`,
      "project",
    );
    if (described) plugins.push(described);
  }
  return plugins;
}

export async function discoverEnginePlugins(
  storage: ProjectStorage,
): Promise<PluginDescriptor[]> {
  let entries;
  try {
    entries = await storage.readdir(".");
  } catch {
    return [];
  }
  const plugins: PluginDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const described = await describePluginFolder(storage, entry.name, "engine");
    if (described) plugins.push(described);
  }
  return plugins;
}

export async function writeProjectPlugin(
  storage: ProjectStorage,
  folderName: string,
  settings: PluginSettingsPayload,
): Promise<PluginDescriptor> {
  const folderPath = `${PLUGINS_DIR}/${folderName}`;
  await storage.mkdir(`${folderPath}/${ASSETS_DIR}`, true);
  const settingsPath = `${folderPath}/${folderName}${PLUGIN_FILE_SUFFIX}`;
  await storage.writeBinary(
    settingsPath,
    await encodePluginSettingsDocument(settings),
  );
  return {
    pluginGuid: settings.pluginGuid,
    folderName,
    folderPath,
    settingsPath,
    contentPath: `${folderPath}/${ASSETS_DIR}`,
    source: "project",
    readOnly: false,
    settings,
  };
}

/** Project plugins with the same guid hide the bundled engine original. */
export function shadowEnginePlugins(
  projectPlugins: readonly PluginDescriptor[],
  enginePlugins: readonly PluginDescriptor[],
): PluginDescriptor[] {
  const projectGuids = new Set(
    projectPlugins.map((plugin) => plugin.pluginGuid),
  );
  return [
    ...enginePlugins.filter((plugin) => !projectGuids.has(plugin.pluginGuid)),
    ...projectPlugins,
  ];
}

export function resolvePluginGraph(
  plugins: readonly PluginGraphInput[],
  engineVersion: string = ENGINE_VERSION,
  overrides: Readonly<Record<string, PluginEnableOverride>> = {},
): { order: PluginGraphInput[]; diagnostics: PluginDiagnostic[] } {
  const byGuid = new Map(plugins.map((plugin) => [plugin.pluginGuid, plugin]));
  const diagnostics: PluginDiagnostic[] = [];
  const blocked = new Set<string>();

  for (const plugin of plugins) {
    const compatibility = pluginCompatibilityDiagnostics(plugin, plugins, engineVersion);
    const accepted = overrides[plugin.pluginGuid]?.acceptedCompatibility ===
      pluginCompatibilityKey(plugin, plugins, engineVersion);
    if (compatibility.length > 0 && !accepted) {
      diagnostics.push(...compatibility);
    }
    for (const dep of plugin.settings.pluginDependencies) {
      const found = byGuid.get(dep.guid);
      if (!found) {
        blocked.add(plugin.pluginGuid);
        diagnostics.push({
          code: "plugin.missing",
          severity: "error",
          pluginGuid: plugin.pluginGuid,
          dependencyGuid: dep.guid,
          recordedVersion: dep.version,
          message: `Plugin ${plugin.pluginGuid} depends on missing plugin ${dep.guid}`,
        });
        continue;
      }
    }
  }

  // A plugin cannot load while any prerequisite is blocked, even if that
  // prerequisite's own version matches the recorded version.
  let blockedCount = -1;
  while (blockedCount !== blocked.size) {
    blockedCount = blocked.size;
    for (const plugin of plugins) {
      if (blocked.has(plugin.pluginGuid)) continue;
      const dependency = plugin.settings.pluginDependencies.find((dep) =>
        blocked.has(dep.guid),
      );
      if (!dependency) continue;
      blocked.add(plugin.pluginGuid);
      diagnostics.push({
        code: "plugin.dependency_blocked",
        severity: "error",
        pluginGuid: plugin.pluginGuid,
        dependencyGuid: dependency.guid,
        message: `Plugin ${plugin.pluginGuid} depends on blocked plugin ${dependency.guid}`,
      });
    }
  }

  const remaining = plugins.filter((plugin) => !blocked.has(plugin.pluginGuid));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const plugin of remaining) {
    inDegree.set(plugin.pluginGuid, 0);
    dependents.set(plugin.pluginGuid, []);
  }
  for (const plugin of remaining) {
    for (const dep of plugin.settings.pluginDependencies) {
      if (!inDegree.has(dep.guid)) continue;
      inDegree.set(
        plugin.pluginGuid,
        (inDegree.get(plugin.pluginGuid) ?? 0) + 1,
      );
      dependents.get(dep.guid)!.push(plugin.pluginGuid);
    }
  }

  const queue = remaining
    .filter((plugin) => (inDegree.get(plugin.pluginGuid) ?? 0) === 0)
    .map((plugin) => plugin.pluginGuid);
  const orderIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    orderIds.push(id);
    for (const next of dependents.get(id) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (orderIds.length !== remaining.length) {
    const cycle = remaining
      .map((plugin) => plugin.pluginGuid)
      .filter((id) => !orderIds.includes(id));
    diagnostics.push({
      code: "plugin.cycle",
      severity: "error",
      plugins: cycle,
      message: `Plugin dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  const byId = new Map(remaining.map((plugin) => [plugin.pluginGuid, plugin]));
  return {
    order: orderIds.map((id) => byId.get(id)!),
    diagnostics,
  };
}

export async function mountEnabledPlugins(
  registry: AssetRegistry,
  plugins: readonly PluginDescriptor[],
  options: {
    enabledGuids: ReadonlySet<string>;
    overrides?: Readonly<Record<string, PluginEnableOverride>>;
    storageFor?: (plugin: PluginDescriptor) => ProjectStorage | undefined;
  },
): Promise<void> {
  const { order } = resolvePluginGraph(
    plugins.filter((plugin) => options.enabledGuids.has(plugin.pluginGuid)),
    ENGINE_VERSION,
    options.overrides,
  );
  const mountIds = new Set(
    order
      .filter((plugin) => options.enabledGuids.has(plugin.pluginGuid))
      .map((plugin) => plugin.pluginGuid),
  );
  for (const root of registry.listRoots()) {
    if (
      root.kind === "plugin" &&
      !mountIds.has(root.id.slice("plugin:".length))
    ) {
      registry.unmountRoot(root.id);
    }
  }
  for (const plugin of order) {
    const descriptor = plugins.find(
      (entry) => entry.pluginGuid === plugin.pluginGuid,
    );
    if (!descriptor || !mountIds.has(descriptor.pluginGuid)) {
      continue;
    }
    const rootId = `plugin:${descriptor.pluginGuid}`;
    if (registry.getRoot(rootId)) registry.unmountRoot(rootId);
    await registry.mountRoot(
      pluginContentRoot({
        id: rootId,
        pathPrefix: descriptor.contentPath,
        readOnly: descriptor.readOnly,
        storage: options.storageFor?.(descriptor),
      }),
    );
  }
}

export function indexUnresolvedPlaceholders(
  registry: AssetRegistry,
  options?: { expectedGuids?: readonly string[] },
): void {
  const missing = new Set(options?.expectedGuids ?? []);
  for (const asset of registry.list()) {
    if (asset.placeholder) continue;
    for (const dep of asset.header.dependencies) {
      const found = registry.getByGuid(dep);
      if (!found || found.placeholder) missing.add(dep);
    }
  }
  for (const guid of missing) {
    const found = registry.getByGuid(guid);
    if (found && !found.placeholder) continue;
    if (found?.placeholder) continue;
    registry.indexPlaceholder(guid);
  }
}

export function collectEnabledPluginAssets(
  registry: AssetRegistry,
  enabledGuids: ReadonlySet<string>,
): IndexedAsset[] {
  const rootIds = new Set([...enabledGuids].map((guid) => `plugin:${guid}`));
  return registry.list().filter((asset) => rootIds.has(asset.rootId));
}
