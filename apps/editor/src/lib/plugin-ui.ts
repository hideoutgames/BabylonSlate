import { pluginFolderSlug, uniquePluginFolderName } from "@babylonslate/assets";

export { pluginFolderSlug, uniquePluginFolderName };

export function pluginDownloadFileName(displayName: string): string {
  return `${pluginFolderSlug(displayName)}.babplugin`;
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

export function isBabpluginFile(name: string): boolean {
  return name.toLowerCase().endsWith(".babplugin");
}

export function filterBabpluginFiles<T extends { name: string }>(
  files: readonly T[],
): T[] {
  return files.filter((file) => !isBabpluginFile(file.name));
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
        !asset.placeholder &&
        (asset.header.type === "Class" || asset.header.type === "Graph"),
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
    .filter(
      (asset) => !asset.placeholder && asset.header.type === "Scene",
    )
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
  return [
    ...fromRegistry,
    ...projectScenes.filter((path) => !seen.has(path)),
  ];
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

export function isPluginSettingsReadOnly(source: "project" | "engine"): boolean {
  return source === "engine";
}

export type PluginDependencyStatusLabel =
  | "ok"
  | "Missing Dependency"
  | "Dependency Cycle"
  | "Engine Range"
  | "Unsatisfiable Range";

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
    forPlugin.some((diagnostic) => diagnostic.code === "plugin.unsatisfiable")
  ) {
    return "Unsatisfiable Range";
  }
  if (
    forPlugin.some(
      (diagnostic) => diagnostic.code === "plugin.engine_unsatisfiable",
    )
  ) {
    return "Engine Range";
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
