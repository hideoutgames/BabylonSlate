import { ENGINE_VERSION, type ProjectStorage } from "@babylonslate/core";
import { decodeAssetDocument } from "./asset-document";
import { readBabassetHeader } from "./babasset";
import {
  ASSETS_DIR,
  decodeProjectZip,
  encodeProjectZip,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  readProjectTree,
  writeProjectTree,
  type BabprojectManifest,
  type ProjectTreeFile,
} from "./babproject";
import { stableStringify } from "./bytes";
import { newAssetGuid } from "./guid";
import { copyStorageTree } from "./storage-move";
import { isPortablePackagePath } from "./package-path";
import {
  discoverEnginePlugins,
  discoverProjectPlugins,
  type PluginDescriptor,
} from "./plugin-host";
import {
  encodePluginSettingsDocument,
  normalizePluginSettings,
  PLUGIN_FILE_SUFFIX,
  PLUGIN_SETTINGS_TYPE,
  type PluginSettingsPayload,
} from "./plugin-settings";

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

export interface InspectedBabplugin {
  manifest: BabprojectManifest;
  settings: PluginSettingsPayload;
  settingsPath: string;
  files: ProjectTreeFile[];
}

export type PluginImportPlan =
  | { kind: "install"; folderName: string }
  | { kind: "update"; folderName: string; existingGuid: string }
  | {
      kind: "conflict";
      folderName: string;
      existingGuid: string;
      version: string;
      replace?: boolean;
    }
  | {
      kind: "remap-plugin";
      folderName: string;
      previousGuid: string;
      nextGuid: string;
    };

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return "";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
  return path;
}

function isPluginManifestPath(path: string): boolean {
  return path === PLUGIN_MANIFEST_FILE || path.endsWith(`/${PLUGIN_MANIFEST_FILE}`);
}

function validatePluginPath(path: string): void {
  if (!isPortablePackagePath(path)) {
    throw new Error(`Invalid plugin path: ${path}`);
  }
}

/** Validate before writing, including portable collisions and explicit ZIP directories. */
function pluginFiles(files: readonly ProjectTreeFile[]): ProjectTreeFile[] {
  const result: ProjectTreeFile[] = [];
  const entries = new Map<string, "file" | "directory">();
  for (const file of files) {
    const directory = file.path.endsWith("/");
    const path = directory ? file.path.slice(0, -1) : file.path;
    validatePluginPath(path);
    const key = path.toLowerCase();
    const previous = entries.get(key);
    if (previous && (!directory || previous !== "directory")) {
      throw new Error(`Conflicting plugin path: ${path}`);
    }
    entries.set(key, directory ? "directory" : "file");
    if (!directory) result.push(file);
  }
  for (const path of entries.keys()) {
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end++) {
      if (entries.get(segments.slice(0, end).join("/")) === "file") {
        throw new Error(`Conflicting plugin path: ${path}`);
      }
    }
  }
  return result;
}

function parseManifest(data: Uint8Array, fallback: BabprojectManifest): BabprojectManifest {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    return {
      kind: "plugin",
      guid: typeof parsed.guid === "string" ? parsed.guid : fallback.guid,
      name: typeof parsed.name === "string" ? parsed.name : fallback.name,
      engineVersion:
        typeof parsed.engineVersion === "string"
          ? parsed.engineVersion
          : fallback.engineVersion,
      version: typeof parsed.version === "number" ? parsed.version : fallback.version,
    };
  } catch {
    return fallback;
  }
}

async function findPluginSettingsFile(
  files: readonly ProjectTreeFile[],
): Promise<ProjectTreeFile | null> {
  const babassets = files.filter((file) => file.path.endsWith(".babasset"));
  const preferred = babassets.filter((file) =>
    file.path.endsWith(PLUGIN_FILE_SUFFIX),
  );
  const candidates = [...preferred, ...babassets.filter((file) => !preferred.includes(file))];
  let best: ProjectTreeFile | null = null;
  for (const file of candidates) {
    try {
      const header = readBabassetHeader(file.data);
      if (header.type !== PLUGIN_SETTINGS_TYPE) continue;
      if (!best || file.path.length < best.path.length) best = file;
    } catch {
      continue;
    }
  }
  return best;
}

export async function inspectBabplugin(bytes: Uint8Array): Promise<InspectedBabplugin> {
  const zipFiles = pluginFiles(decodeProjectZip(bytes));
  const settingsFile = await findPluginSettingsFile(zipFiles);
  if (!settingsFile) {
    throw new Error("Not a .babplugin: missing PluginSettings");
  }
  const document = await decodeAssetDocument(settingsFile.data);
  const settings = normalizePluginSettings(document.payload, {
    pluginGuid: document.guid,
    displayName: document.name,
  });
  const rootPrefix = dirname(settingsFile.path);
  const files = pluginFiles(zipFiles
    .filter((file) => !rootPrefix || file.path.startsWith(`${rootPrefix}/`))
    .filter((file) => !isPluginManifestPath(file.path))
    .map((file) => ({
      path: stripPrefix(file.path, rootPrefix),
      data: file.data,
    }))
    .filter((file) => file.path !== ""));
  const fallbackManifest: BabprojectManifest = {
    kind: "plugin",
    guid: settings.pluginGuid,
    name: settings.displayName,
    engineVersion: ENGINE_VERSION,
    version: 1,
  };
  const manifestFile = zipFiles.find((file) => isPluginManifestPath(file.path));
  return {
    manifest: manifestFile
      ? parseManifest(manifestFile.data, fallbackManifest)
      : fallbackManifest,
    settings,
    settingsPath: stripPrefix(settingsFile.path, rootPrefix),
    files,
  };
}

export async function exportPluginZip(
  storage: ProjectStorage,
  descriptor: PluginDescriptor,
): Promise<Uint8Array> {
  const tree = await readProjectTree(storage, descriptor.folderPath);
  const files: ProjectTreeFile[] = tree
    .map((file) => ({
      path: stripPrefix(file.path, descriptor.folderPath),
      data: file.data,
    }))
    .filter((file) => file.path !== "" && !isPluginManifestPath(file.path));
  const manifest: BabprojectManifest = {
    kind: "plugin",
    guid: descriptor.pluginGuid,
    name: descriptor.settings.displayName,
    engineVersion: ENGINE_VERSION,
    version: 1,
  };
  files.push({
    path: PLUGIN_MANIFEST_FILE,
    data: new TextEncoder().encode(stableStringify(manifest)),
  });
  return encodeProjectZip(files);
}

export function planPluginImport(options: {
  incoming: InspectedBabplugin;
  existingPlugins: readonly PluginDescriptor[];
  occupiedGuids: ReadonlySet<string>;
  existingFolderNames: readonly string[];
  createGuid?: () => string;
}): PluginImportPlan {
  const guid = options.incoming.settings.pluginGuid;
  const existing = options.existingPlugins.find(
    (plugin) => plugin.pluginGuid === guid,
  );
  if (existing) {
    if (existing.settings.version === options.incoming.settings.version) {
      return {
        kind: "conflict",
        folderName: existing.folderName,
        existingGuid: guid,
        version: existing.settings.version,
      };
    }
    return {
      kind: "update",
      folderName: existing.folderName,
      existingGuid: guid,
    };
  }
  const folderName = uniquePluginFolderName(
    options.incoming.settings.displayName,
    options.existingFolderNames,
  );
  if (options.occupiedGuids.has(guid)) {
    return {
      kind: "remap-plugin",
      folderName,
      previousGuid: guid,
      nextGuid: (options.createGuid ?? newAssetGuid)(),
    };
  }
  return { kind: "install", folderName };
}

async function rewritePluginSettingsGuid(
  bytes: Uint8Array,
  nextGuid: string,
): Promise<Uint8Array> {
  const document = await decodeAssetDocument(bytes);
  const settings = normalizePluginSettings(document.payload, {
    pluginGuid: nextGuid,
    displayName: document.name,
  });
  return encodePluginSettingsDocument({ ...settings, pluginGuid: nextGuid });
}

async function cleanupImport(storage: ProjectStorage, folderPath: string): Promise<void> {
  try {
    await storage.remove(folderPath);
  } catch {
    // Cleanup must not obscure the operation's result. A retained recovery copy is safe.
  }
}

export async function applyPluginImport(
  storage: ProjectStorage,
  incoming: InspectedBabplugin,
  plan: PluginImportPlan,
): Promise<PluginDescriptor> {
  const replace =
    plan.kind === "update" ||
    (plan.kind === "conflict" && plan.replace === true);
  if (plan.kind === "conflict" && !replace) {
    throw new Error("Plugin import conflict was not replaced");
  }
  const folderName = plan.folderName;
  validatePluginPath(folderName);
  if (folderName.includes("/")) throw new Error("Plugin folder must be a single name");
  const files = pluginFiles(incoming.files);
  if (!files.some((file) => file.path === incoming.settingsPath)) {
    throw new Error("Not a .babplugin: missing PluginSettings");
  }
  const folderPath = `${PLUGINS_DIR}/${folderName}`;
  const hadOriginal = await storage.exists(folderPath);
  if (hadOriginal && !replace) {
    throw new Error(`Plugin folder already exists: ${folderPath}`);
  }
  // Stage outside plugins/ so discovery cannot mistake recovery copies for plugins.
  const transaction = `.babylonslate-plugin-import-${newAssetGuid()}`;
  const staged = `${transaction}/incoming`;
  const backup = `${transaction}/original`;
  const remapGuid = plan.kind === "remap-plugin" ? plan.nextGuid : null;
  const out: ProjectTreeFile[] = [];
  for (const file of files) {
    let data = file.data;
    if (remapGuid && file.path === incoming.settingsPath) {
      data = await rewritePluginSettingsGuid(file.data, remapGuid);
    }
    out.push({ path: `${staged}/${file.path}`, data });
  }
  try {
    await storage.mkdir(`${staged}/${ASSETS_DIR}`, true);
    await writeProjectTree(storage, out);
    if (hadOriginal) await copyStorageTree(storage, folderPath, backup);
  } catch (error) {
    await cleanupImport(storage, transaction);
    throw error;
  }
  try {
    if (hadOriginal) await storage.remove(folderPath);
    await copyStorageTree(storage, staged, folderPath);
    const discovered = await discoverProjectPlugins(storage);
    const imported = discovered.find((plugin) => plugin.folderName === folderName);
    if (!imported) throw new Error(`Failed to import plugin into ${folderPath}`);
    await cleanupImport(storage, transaction);
    return imported;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (await storage.exists(folderPath)) await storage.remove(folderPath);
      if (hadOriginal) await copyStorageTree(storage, backup, folderPath);
    } catch (restoreError) {
      failures.push(restoreError);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, `Plugin import failed; recovery files remain at ${transaction}`, { cause: error });
    await cleanupImport(storage, transaction);
    throw error;
  }
}

export async function unpackEnginePluginZip(
  storage: ProjectStorage,
  zip: Uint8Array,
  folderName: string,
): Promise<PluginDescriptor> {
  validatePluginPath(folderName);
  if (folderName.includes("/")) throw new Error("Plugin folder must be a single name");
  const incoming = await inspectBabplugin(zip);
  const out: ProjectTreeFile[] = incoming.files.map((file) => ({
    path: `${folderName}/${file.path}`,
    data: file.data,
  }));
  await storage.mkdir(`${folderName}/${ASSETS_DIR}`, true);
  await writeProjectTree(storage, out);
  const discovered = await discoverEnginePlugins(storage);
  const imported = discovered.find((plugin) => plugin.folderName === folderName);
  if (!imported) {
    throw new Error(`Failed to unpack engine plugin into ${folderName}`);
  }
  return imported;
}

export async function installEnginePluginDefaults(
  projectStorage: ProjectStorage,
  engineStorage: ProjectStorage,
): Promise<PluginDescriptor[]> {
  const existing = await discoverProjectPlugins(projectStorage);
  const existingGuids = new Set(existing.map((plugin) => plugin.pluginGuid));
  const folderNames = existing.map((plugin) => plugin.folderName);
  const installed: PluginDescriptor[] = [];
  for (const plugin of await discoverEnginePlugins(engineStorage)) {
    if (existingGuids.has(plugin.pluginGuid)) continue;
    const folderName = uniquePluginFolderName(plugin.folderName, folderNames);
    folderNames.push(folderName);
    const files = await readProjectTree(engineStorage, plugin.folderPath);
    const prefix = plugin.folderPath;
    const destRoot = `${PLUGINS_DIR}/${folderName}`;
    const remapped: ProjectTreeFile[] = [];
    for (const file of files) {
      const relative = stripPrefix(file.path, prefix);
      const path = relative ? `${destRoot}/${relative}` : destRoot;
      remapped.push({
        path,
        data: file.data,
      });
    }
    await writeProjectTree(projectStorage, remapped);
    existingGuids.add(plugin.pluginGuid);
    const described = (await discoverProjectPlugins(projectStorage)).find(
      (entry) => entry.pluginGuid === plugin.pluginGuid,
    );
    if (described) installed.push(described);
  }
  return installed;
}
