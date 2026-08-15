export const PROJECT_CONTENT_ROOT_ID = "project";

export function pluginRootId(pluginGuid: string): string {
  return `plugin:${pluginGuid}`;
}

export function pluginFolderSlug(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "plugin";
}

export function uniquePluginFolderName(
  displayName: string,
  existingFolderNames: readonly string[],
): string {
  const base = pluginFolderSlug(displayName);
  const used = new Set(existingFolderNames.map((name) => name.toLowerCase()));
  if (!used.has(base)) return base;
  let index = 1;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
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

export function isPluginSettingsReadOnly(source: "project" | "engine"): boolean {
  return source === "engine";
}

export function pluginDependencyStatus(
  pluginGuid: string,
  diagnostics: ReadonlyArray<{
    code: string;
    pluginGuid?: string;
    plugins?: string[];
  }>,
): "ok" | "missing" | "unsatisfiable" | "cycle" | "engine" {
  const forPlugin = diagnostics.filter(
    (diagnostic) =>
      diagnostic.pluginGuid === pluginGuid ||
      diagnostic.plugins?.includes(pluginGuid),
  );
  if (forPlugin.some((diagnostic) => diagnostic.code === "plugin.cycle")) {
    return "cycle";
  }
  if (forPlugin.some((diagnostic) => diagnostic.code === "plugin.missing")) {
    return "missing";
  }
  if (
    forPlugin.some((diagnostic) => diagnostic.code === "plugin.unsatisfiable")
  ) {
    return "unsatisfiable";
  }
  if (
    forPlugin.some(
      (diagnostic) => diagnostic.code === "plugin.engine_unsatisfiable",
    )
  ) {
    return "engine";
  }
  return "ok";
}
