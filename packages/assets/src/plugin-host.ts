import { ENGINE_VERSION, type ProjectStorage } from "@babylonslate/core";
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
import { satisfiesRange } from "./semver-range";

export type PluginSource = "project" | "engine";

export type PluginDiagnosticCode =
  | "plugin.cycle"
  | "plugin.unsatisfiable"
  | "plugin.missing"
  | "plugin.engine_unsatisfiable";

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  pluginGuid?: string;
  plugins?: string[];
  dependencyGuid?: string;
  versionRange?: string;
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

export type PluginGraphInput = Pick<PluginDescriptor, "pluginGuid" | "settings">;

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
  const candidates = [...preferred, ...files.filter((file) => !preferred.includes(file))];
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

export function resolvePluginGraph(
  plugins: readonly PluginGraphInput[],
  engineVersion: string = ENGINE_VERSION,
): { order: PluginGraphInput[]; diagnostics: PluginDiagnostic[] } {
  const byGuid = new Map(plugins.map((plugin) => [plugin.pluginGuid, plugin]));
  const diagnostics: PluginDiagnostic[] = [];
  const blocked = new Set<string>();

  for (const plugin of plugins) {
    if (!satisfiesRange(engineVersion, plugin.settings.engineVersionRange)) {
      blocked.add(plugin.pluginGuid);
      diagnostics.push({
        code: "plugin.engine_unsatisfiable",
        pluginGuid: plugin.pluginGuid,
        versionRange: plugin.settings.engineVersionRange,
        foundVersion: engineVersion,
        message: `Plugin ${plugin.pluginGuid} requires engine ${plugin.settings.engineVersionRange} (have ${engineVersion})`,
      });
    }
    for (const dep of plugin.settings.pluginDependencies) {
      const found = byGuid.get(dep.guid);
      if (!found) {
        blocked.add(plugin.pluginGuid);
        diagnostics.push({
          code: "plugin.missing",
          pluginGuid: plugin.pluginGuid,
          dependencyGuid: dep.guid,
          versionRange: dep.versionRange,
          message: `Plugin ${plugin.pluginGuid} depends on missing plugin ${dep.guid}`,
        });
        continue;
      }
      if (!satisfiesRange(found.settings.version, dep.versionRange)) {
        blocked.add(plugin.pluginGuid);
        diagnostics.push({
          code: "plugin.unsatisfiable",
          pluginGuid: plugin.pluginGuid,
          dependencyGuid: dep.guid,
          versionRange: dep.versionRange,
          foundVersion: found.settings.version,
          message: `Plugin ${plugin.pluginGuid} needs ${dep.guid} ${dep.versionRange} (have ${found.settings.version})`,
        });
      }
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
      inDegree.set(plugin.pluginGuid, (inDegree.get(plugin.pluginGuid) ?? 0) + 1);
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
    storageFor?: (plugin: PluginDescriptor) => ProjectStorage | undefined;
  },
): Promise<void> {
  const { order } = resolvePluginGraph(plugins);
  const mountIds = new Set(
    order
      .filter((plugin) => options.enabledGuids.has(plugin.pluginGuid))
      .map((plugin) => plugin.pluginGuid),
  );
  for (const plugin of plugins) {
    const rootId = `plugin:${plugin.pluginGuid}`;
    if (!mountIds.has(plugin.pluginGuid) && registry.getRoot(rootId)) {
      registry.unmountRoot(rootId);
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
  const rootIds = new Set(
    [...enabledGuids].map((guid) => `plugin:${guid}`),
  );
  return registry.list().filter((asset) => rootIds.has(asset.rootId));
}
