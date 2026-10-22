import { pluginFolderSlug, resolvePluginEnabled, uniquePluginFolderName } from "@haptic/assets";

export { pluginFolderSlug, uniquePluginFolderName };

export function pluginDownloadFileName(displayName: string): string {
  return `${pluginFolderSlug(displayName)}.hplugin`;
}

/** New Plugin always reveals plugin roots in the Content Browser. */
export async function createProjectPluginAndRevealContent<T>(
  create: (displayName: string) => Promise<T>,
  setShowPluginContent: (show: boolean) => void,
  displayName: string,
): Promise<T> {
  const created = await create(displayName);
  setShowPluginContent(true);
  return created;
}

export const PROJECT_CONTENT_ROOT_ID = "project";

export function pluginRootId(pluginGuid: string): string {
  return `plugin:${pluginGuid}`;
}

export function isHpluginFile(name: string): boolean {
  return name.toLowerCase().endsWith(".hplugin");
}

export function filterHpluginFiles<T extends { name: string }>(
  files: readonly T[],
): T[] {
  return files.filter((file) => !isHpluginFile(file.name));
}

export interface ContentBrowserRoot {
  id: string;
  label: string;
  pathPrefix: string;
  readOnly: boolean;
  source: "project" | "engine";
}

export function contentBrowserRoots(options: {
  showPluginContent: boolean;
  plugins: ReadonlyArray<{
    pluginGuid: string;
    displayName: string;
    contentPath: string;
    source: "project" | "engine";
    enabled: boolean;
  }>;
}): ContentBrowserRoot[] {
  const project: ContentBrowserRoot = {
    id: PROJECT_CONTENT_ROOT_ID,
    label: "assets",
    pathPrefix: "assets",
    readOnly: false,
    source: "project",
  };
  if (!options.showPluginContent) return [project];
  return [
    project,
    ...options.plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({
        id: pluginRootId(plugin.pluginGuid),
        label: plugin.displayName,
        pathPrefix: plugin.contentPath,
        readOnly: plugin.source === "engine",
        source: plugin.source,
      })),
  ];
}

export function rootIdForFolderPath(
  path: string,
  roots: readonly ContentBrowserRoot[],
): string {
  const matches = roots.filter(
    (root) =>
      path === root.pathPrefix || path.startsWith(`${root.pathPrefix}/`),
  );
  matches.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  return matches[0]?.id ?? PROJECT_CONTENT_ROOT_ID;
}

export function contentBrowserRootForPath(
  path: string,
  roots: readonly ContentBrowserRoot[],
): ContentBrowserRoot | undefined {
  const id = rootIdForFolderPath(path, roots);
  return roots.find((root) => root.id === id);
}

export function canMutateContentBrowserRoot(
  root: ContentBrowserRoot | undefined,
): boolean {
  return Boolean(root && !root.readOnly);
}

export function isPluginContentFolderPath(
  folderPath: string,
  pluginPathPrefixes: readonly string[],
): boolean {
  return pluginPathPrefixes.some(
    (prefix) => folderPath === prefix || folderPath.startsWith(`${prefix}/`),
  );
}

export function contentBrowserFolderOps(
  folderPath: string,
  roots: readonly ContentBrowserRoot[],
): {
  rootId: string;
  pathPrefix: string;
  relative: string;
  readOnly: boolean;
} {
  const root = contentBrowserRootForPath(folderPath, roots);
  const pathPrefix = root?.pathPrefix ?? "assets";
  const relative =
    folderPath === pathPrefix
      ? ""
      : folderPath.startsWith(`${pathPrefix}/`)
        ? folderPath.slice(pathPrefix.length + 1)
        : "";
  return {
    rootId: root?.id ?? PROJECT_CONTENT_ROOT_ID,
    pathPrefix,
    relative,
    readOnly: root?.readOnly ?? false,
  };
}

export function inboundRefsFromOtherRoots(
  assets: ReadonlyArray<{
    rootId: string;
    header: { guid: string; name: string };
  }>,
  showReferences: (guid: string) => { inbound: string[] },
  targetRootId: string,
): Array<{ guid: string; name: string }> {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset]));
  const names: Array<{ guid: string; name: string }> = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    if (asset.rootId !== targetRootId) continue;
    for (const inbound of showReferences(asset.header.guid).inbound) {
      const referrer = byGuid.get(inbound);
      if (!referrer || referrer.rootId === targetRootId) continue;
      if (seen.has(referrer.header.guid)) continue;
      seen.add(referrer.header.guid);
      names.push({
        guid: referrer.header.guid,
        name: referrer.header.name,
      });
    }
  }
  return names;
}

export interface ContentRootMovePlugin {
  pluginGuid: string;
  displayName: string;
  enabledByDefault: boolean;
  /** Guids of the plugins its settings list as dependencies. */
  dependencyGuids: readonly string[];
}

/**
 * Why moving `movedGuids` into the root `targetRootId` changes how the
 * project and its plugins behave; empty when it does not. Two things change:
 *
 * - A plugin starts to reference content outside itself (the project, or a
 *   plugin it does not list as a dependency): content moved into it keeps
 *   its references, and a plugin's content keeps referencing content moved
 *   out of it. A copy of the plugin exported or installed elsewhere then
 *   misses that content.
 * - An export preset turns the target plugin off while it includes the
 *   moved content's current root, so its exports stop shipping that content.
 *
 * References follow the saved headers (`showReferences`). Items already in
 * the target root, and missing placeholders, change nothing.
 */
export function contentRootMoveWarnings(input: {
  movedGuids: readonly string[];
  targetRootId: string;
  assets: ReadonlyArray<{ rootId: string; placeholder?: boolean; header: { guid: string; name: string } }>;
  showReferences: (guid: string) => { outbound: readonly string[]; inbound: readonly string[] };
  plugins: readonly ContentRootMovePlugin[];
  projectPluginOverrides?: Readonly<Record<string, { enabled: boolean } | undefined>>;
  exportPresets?: ReadonlyArray<{ name: string; pluginOverrides: Readonly<Record<string, { enabled: boolean } | undefined>> }>;
}): string[] {
  const { targetRootId: target } = input;
  const moved = new Set(input.movedGuids);
  const byGuid = new Map(input.assets.map((asset) => [asset.header.guid, asset]));
  const plugins = new Map(input.plugins.map((plugin) => [pluginRootId(plugin.pluginGuid), plugin]));
  const present = (guid: string) => {
    const asset = byGuid.get(guid);
    return asset && !asset.placeholder ? asset : undefined;
  };
  /** Whether content of root `from` may use content of root `to` without a new outside reference. */
  const reaches = (from: string, to: string) => {
    if (from === to) return true;
    const plugin = plugins.get(from);
    if (!plugin) return true;
    const dependency = plugins.get(to);
    return dependency !== undefined && plugin.dependencyGuids.includes(dependency.pluginGuid);
  };
  const leaving = [...moved].flatMap((guid) => {
    const asset = present(guid);
    return asset && asset.rootId !== target ? [asset] : [];
  });
  /** Plugin root id -> guids of the outside content it will newly use. */
  const outside = new Map<string, Set<string>>();
  const note = (rootId: string, guid: string) => {
    const guids = outside.get(rootId) ?? new Set<string>();
    guids.add(guid);
    outside.set(rootId, guids);
  };
  for (const asset of leaving) {
    const { outbound, inbound } = input.showReferences(asset.header.guid);
    for (const guid of outbound) {
      const used = present(guid);
      if (used && !moved.has(guid) && !reaches(target, used.rootId)) note(target, guid);
    }
    for (const guid of inbound) {
      const referrer = present(guid);
      if (!referrer || moved.has(guid)) continue;
      if (reaches(referrer.rootId, asset.rootId) && !reaches(referrer.rootId, target)) note(referrer.rootId, asset.header.guid);
    }
  }
  const nameOf = (rootId: string) => plugins.get(rootId)?.displayName ?? rootId;
  const warnings = [...outside].map(([rootId, guids]) => {
    const names = [...guids].map((guid) => byGuid.get(guid)?.header.name ?? guid).sort((a, b) => a.localeCompare(b));
    return `${nameOf(rootId)} will use ${listNames(names)} from outside the plugin. A copy of the plugin exported or installed in another project will be missing ${names.length === 1 ? "it" : "them"}.`;
  });

  const targetPlugin = plugins.get(target);
  if (targetPlugin && leaving.length > 0) {
    const sources = new Set(leaving.map((asset) => asset.rootId));
    const presets = (input.exportPresets ?? []).filter((preset) => {
      const enabled = (plugin: ContentRootMovePlugin) => resolvePluginEnabled(
        plugin.enabledByDefault,
        input.projectPluginOverrides?.[plugin.pluginGuid]?.enabled,
        preset.pluginOverrides[plugin.pluginGuid]?.enabled,
      );
      if (enabled(targetPlugin)) return false;
      return [...sources].some((rootId) => {
        const source = plugins.get(rootId);
        return !source || enabled(source);
      });
    });
    if (presets.length > 0) {
      const names = listNames(presets.map((preset) => `"${preset.name}"`));
      warnings.push(presets.length === 1
        ? `Export preset ${names} turns off ${targetPlugin.displayName}, so its exports will not include the moved items.`
        : `Export presets ${names} turn off ${targetPlugin.displayName}, so their exports will not include the moved items.`);
    }
  }
  return warnings;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function listNames(names: readonly string[], limit = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  const shown = names.length > limit ? names.slice(0, limit) : names.slice(0, -1);
  const last = names.length > limit ? `${names.length - limit} more` : names.at(-1)!;
  return `${shown.join(", ")} and ${last}`;
}

export function mergePluginEditorUtilityObjects(
  projectIds: readonly string[],
  enabledPlugins: ReadonlyArray<{ editorUtilityObjects: readonly string[] }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...projectIds,
    ...enabledPlugins.flatMap((plugin) => plugin.editorUtilityObjects),
  ]) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function pluginEnableNeedsConfirm(plugin: {
  experimental: boolean;
  beta: boolean;
}): boolean {
  return plugin.experimental || plugin.beta;
}

export function classAssetPaths(
  assets: ReadonlyArray<{
    path: string;
    placeholder?: boolean;
    header: { type: string };
  }>,
): string[] {
  return assets
    .filter(
      (asset) =>
        !asset.placeholder && asset.header.type === "Class",
    )
    .map((asset) => asset.path)
    .sort();
}

export function sceneAssetPaths(
  assets: ReadonlyArray<{
    path: string;
    placeholder?: boolean;
    header: { type: string };
  }>,
): string[] {
  return assets
    .filter((asset) => !asset.placeholder && asset.header.type === "Scene")
    .map((asset) => asset.path)
    .sort();
}

/** Play `changescene` library: every mounted Scene, plus project.json extras. */
export function playSceneLibraryPaths(
  projectScenes: readonly string[],
  assets: ReadonlyArray<{
    path: string;
    placeholder?: boolean;
    header: { type: string };
  }>,
): string[] {
  const fromRegistry = sceneAssetPaths(assets);
  const seen = new Set(fromRegistry);
  return [...fromRegistry, ...projectScenes.filter((path) => !seen.has(path))];
}

export function isPluginDocumentReadOnly(
  plugins: ReadonlyArray<{
    folderPath: string;
    settingsPath: string;
    readOnly: boolean;
  }>,
  path: string,
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.readOnly &&
      (path === plugin.settingsPath ||
        path.startsWith(`${plugin.folderPath}/`)),
  );
}

export function isPluginSettingsReadOnly(
  source: "project" | "engine",
): boolean {
  return source === "engine";
}

export type PluginDependencyStatusLabel =
  | "ok"
  | "Missing Dependency"
  | "Blocked Dependency"
  | "Dependency Cycle"
  | "Engine Version Changed"
  | "Dependency Version Changed";

export function pluginDependencyStatus(
  pluginGuid: string,
  diagnostics: ReadonlyArray<{
    code: string;
    pluginGuid?: string;
    plugins?: string[];
  }>,
): PluginDependencyStatusLabel {
  const forPlugin = diagnostics.filter(
    (diagnostic) =>
      diagnostic.pluginGuid === pluginGuid ||
      diagnostic.plugins?.includes(pluginGuid),
  );
  if (forPlugin.some((diagnostic) => diagnostic.code === "plugin.cycle")) {
    return "Dependency Cycle";
  }
  if (forPlugin.some((diagnostic) => diagnostic.code === "plugin.missing")) {
    return "Missing Dependency";
  }
  if (
    forPlugin.some(
      (diagnostic) => diagnostic.code === "plugin.dependency_blocked",
    )
  ) {
    return "Blocked Dependency";
  }
  if (
    forPlugin.some((diagnostic) => diagnostic.code === "plugin.unsatisfiable")
  ) {
    return "Dependency Version Changed";
  }
  if (
    forPlugin.some(
      (diagnostic) => diagnostic.code === "plugin.engine_unsatisfiable",
    )
  ) {
    return "Engine Version Changed";
  }
  return "ok";
}

export interface PluginSettingsIdentityField {
  id: string;
  label: string;
  value: string;
  readOnly: boolean;
}

export function pluginSettingsIdentityFields(settings: {
  pluginGuid: string;
  displayName: string;
  version: string;
  author: string;
  category: string;
  iconKey?: string | null;
}): PluginSettingsIdentityField[] {
  return [
    {
      id: "pluginGuid",
      label: "GUID",
      value: settings.pluginGuid,
      readOnly: true,
    },
    {
      id: "displayName",
      label: "Display Name",
      value: settings.displayName,
      readOnly: false,
    },
    {
      id: "version",
      label: "Version",
      value: settings.version,
      readOnly: false,
    },
    {
      id: "author",
      label: "Author",
      value: settings.author,
      readOnly: false,
    },
    {
      id: "category",
      label: "Category",
      value: settings.category,
      readOnly: false,
    },
    {
      id: "iconKey",
      label: "Icon Key",
      value: settings.iconKey ?? "",
      readOnly: false,
    },
  ];
}
