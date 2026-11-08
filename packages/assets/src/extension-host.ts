import { ENGINE_VERSION, newGuid, type ProjectStorage } from "@haptic/core";
import { resolvePluginGraph, type PluginDiagnostic, type PluginGraphInput } from "./plugin-host";
import { extensionContentRoot, extensionContentRootId } from "./content-root";
import type { AssetRegistry } from "./registry";
import {
  createDefaultExtensionSettings,
  decodeExtensionSettings,
  encodeExtensionSettings,
  EXTENSION_MANIFEST_FILE,
  EXTENSIONS_DIR,
  isExtensionCodePath,
  isExtensionPackagePath,
  normalizeExtensionSettings,
  type ExtensionSettings,
} from "./extension-settings";

export interface ExtensionEnableOverride {
  enabled?: boolean;
}

export interface ExtensionDescriptor {
  extensionGuid: string;
  folderName: string;
  folderPath: string;
  settingsPath: string;
  contentPath: string;
  source: "project" | "engine";
  readOnly: boolean;
  settings: ExtensionSettings;
  /** Invalid packages remain listed for diagnosis/deletion but can never activate. */
  invalid?: string;
}

export interface ExtensionDiagnostic {
  code: `extension.${"cycle" | "unsatisfiable" | "dependency_blocked" | "missing" | "engine_unsatisfiable" | "invalid"}`;
  severity: "warning" | "error";
  message: string;
  extensionGuid?: string;
  extensions?: string[];
  dependencyGuid?: string;
  recordedVersion?: string;
  foundVersion?: string;
}

export function createExtensionSettings(displayName: string, extensionGuid = newGuid()): ExtensionSettings {
  return createDefaultExtensionSettings({ displayName: displayName.trim() || "Extension", extensionGuid });
}

function resolveExtensionEnabled(enabledByDefault: boolean, projectOverride?: boolean): boolean {
  return projectOverride ?? enabledByDefault;
}

function describeExtension(folderPath: string, source: "project" | "engine", settings: ExtensionSettings): ExtensionDescriptor {
  return {
    extensionGuid: settings.extensionGuid,
    folderName: folderPath.slice(folderPath.lastIndexOf("/") + 1),
    folderPath,
    settingsPath: `${folderPath}/${EXTENSION_MANIFEST_FILE}`,
    contentPath: `${folderPath}/assets`,
    source,
    readOnly: source === "engine",
    settings,
  };
}

function invalidExtension(folderPath: string, source: "project" | "engine", message: string): ExtensionDescriptor {
  const folderName = folderPath.slice(folderPath.lastIndexOf("/") + 1);
  return {
    ...describeExtension(folderPath, source, createDefaultExtensionSettings({
      extensionGuid: `invalid-extension:${source}:${encodeURIComponent(folderPath)}`,
      displayName: folderName,
    })),
    invalid: message,
  };
}

async function discoverExtensions(storage: ProjectStorage, source: "project" | "engine"): Promise<ExtensionDescriptor[]> {
  const root = source === "project" ? EXTENSIONS_DIR : ".";
  if (!(await storage.exists(root))) return [];
  const extensions: ExtensionDescriptor[] = [];
  for (const entry of (await storage.readdir(root)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDir) continue;
    const folderPath = source === "project" ? `${root}/${entry.name}` : entry.name;
    const manifestPath = `${folderPath}/${EXTENSION_MANIFEST_FILE}`;
    if (!(await storage.exists(manifestPath))) continue;
    try {
      const settings = decodeExtensionSettings(await storage.readBinary(manifestPath));
      extensions.push(describeExtension(folderPath, source, settings));
    } catch (cause) {
      extensions.push(invalidExtension(folderPath, source, cause instanceof Error ? cause.message : String(cause)));
    }
  }
  const counts = new Map<string, number>();
  for (const extension of extensions) {
    if (!extension.invalid) counts.set(extension.extensionGuid, (counts.get(extension.extensionGuid) ?? 0) + 1);
  }
  return extensions.map((extension) => !extension.invalid && (counts.get(extension.extensionGuid) ?? 0) > 1
    ? invalidExtension(extension.folderPath, source, `Duplicate Extension ID: ${extension.extensionGuid}`)
    : extension);
}

export function discoverProjectExtensions(storage: ProjectStorage): Promise<ExtensionDescriptor[]> {
  return discoverExtensions(storage, "project");
}

export function discoverEngineExtensions(storage: ProjectStorage): Promise<ExtensionDescriptor[]> {
  return discoverExtensions(storage, "engine");
}

export async function writeProjectExtension(
  storage: ProjectStorage,
  folderName: string,
  settings: ExtensionSettings,
  source = "export function activate(api) {\n  // Edit this module to register editor commands and asset tools.\n  api.registerCommand({ id: 'hello', title: 'Hello', execute: () => api.log('Hello from this Extension') });\n}\n",
): Promise<ExtensionDescriptor> {
  if (!isExtensionPackagePath(folderName) || folderName.includes("/")) {
    throw new Error("Invalid Extension folder name.");
  }
  const normalized = normalizeExtensionSettings(settings);
  const folderPath = `${EXTENSIONS_DIR}/${folderName}`;
  if (await storage.exists(folderPath)) throw new Error("The Extension folder already exists.");
  await storage.mkdir(`${folderPath}/assets`, true);
  const entryPath = `${folderPath}/${normalized.entryPoint}`;
  await storage.mkdir(entryPath.slice(0, entryPath.lastIndexOf("/")), true);
  await storage.writeText(entryPath, source);
  await storage.writeBinary(`${folderPath}/${EXTENSION_MANIFEST_FILE}`, encodeExtensionSettings(normalized));
  return describeExtension(folderPath, "project", normalized);
}

/** Starting game entry for a package whose Editor Only is turned off. */
export const DEFAULT_EXTENSION_GAME_SOURCE = "// Exports from this file are the extension's game library.\n// Execute JavaScript nodes call them through extensions.<Library Name>.\nexport function describe(value) {\n  return `Value: ${value}`;\n}\n";

export interface ExtensionCodeFile {
  /** Package-relative path. */
  path: string;
  source: string;
}

/** Every `.ts` / `.js` file of a package outside its `assets/` root, sorted by path. */
export async function readExtensionCodeFiles(storage: ProjectStorage, folderPath: string): Promise<ExtensionCodeFile[]> {
  const files: ExtensionCodeFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await storage.readdir(relative ? `${folderPath}/${relative}` : folderPath);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (relative || entry.name.toLowerCase() !== "assets") await walk(path);
      } else if (isExtensionCodePath(path)) {
        files.push({ path, source: await storage.readText(`${folderPath}/${path}`) });
      }
    }
  };
  await walk("");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function shadowEngineExtensions(
  projectExtensions: readonly ExtensionDescriptor[],
  engineExtensions: readonly ExtensionDescriptor[],
): ExtensionDescriptor[] {
  const projectGuids = new Set(projectExtensions.map((extension) => extension.extensionGuid));
  return [...engineExtensions.filter((extension) => !projectGuids.has(extension.extensionGuid)), ...projectExtensions];
}

function asPlugin(extension: ExtensionDescriptor): PluginGraphInput {
  return {
    pluginGuid: extension.extensionGuid,
    settings: {
      ...extension.settings,
      pluginGuid: extension.extensionGuid,
      pluginDependencies: extension.settings.extensionDependencies,
      editorUtilityObjects: [],
    },
  };
}

function extensionDiagnostic(diagnostic: PluginDiagnostic): ExtensionDiagnostic {
  const { pluginGuid, plugins, code, message, ...details } = diagnostic;
  const extensionMessage = code === "plugin.missing"
    ? `Extension ${pluginGuid} depends on missing extension ${diagnostic.dependencyGuid}`
    : code === "plugin.dependency_blocked"
      ? `Extension ${pluginGuid} depends on blocked extension ${diagnostic.dependencyGuid}`
      : code === "plugin.cycle"
        ? `Extension dependency cycle: ${plugins?.join(" -> ")}`
        : message;
  return {
    ...details,
    code: code.replace("plugin.", "extension.") as ExtensionDiagnostic["code"],
    message: extensionMessage,
    ...(pluginGuid ? { extensionGuid: pluginGuid } : {}),
    ...(plugins ? { extensions: plugins } : {}),
  };
}

/** Resolve enabled packages, dependencies first; mounting gameplay content is `mountExtensionContentRoots`. */
export function resolveExtensionGraph(
  extensions: readonly ExtensionDescriptor[],
  engineVersion = ENGINE_VERSION,
  overrides: Readonly<Record<string, ExtensionEnableOverride>> = {},
): { order: ExtensionDescriptor[]; diagnostics: ExtensionDiagnostic[] } {
  const enabled = extensions.filter((extension) => !extension.invalid && resolveExtensionEnabled(
    extension.settings.enabledByDefault,
    overrides[extension.extensionGuid]?.enabled,
  ));
  const result = resolvePluginGraph(enabled.map(asPlugin), engineVersion);
  const byGuid = new Map(enabled.map((extension) => [extension.extensionGuid, extension]));
  return {
    order: result.order.map((entry) => byGuid.get(entry.pluginGuid)!),
    diagnostics: [
      ...extensions.flatMap((extension): ExtensionDiagnostic[] => extension.invalid ? [{
        code: "extension.invalid",
        severity: "error",
        extensionGuid: extension.extensionGuid,
        message: `${extension.folderPath}: ${extension.invalid}`,
      }] : []),
      ...result.diagnostics.map(extensionDiagnostic),
    ],
  };
}

/**
 * Mounts the `assets/` root of each given gameplay extension (enabled, valid,
 * not Editor Only) as `extension:<guid>` and unmounts every other extension
 * root, so their content reaches pickers, Play and export like a plugin's.
 */
export async function mountExtensionContentRoots(
  registry: AssetRegistry,
  extensions: readonly ExtensionDescriptor[],
  options: { storageFor?: (extension: ExtensionDescriptor) => ProjectStorage | undefined } = {},
): Promise<void> {
  const mount = extensions.filter((extension) => !extension.invalid && !extension.settings.editorOnly);
  const ids = new Set(mount.map((extension) => extensionContentRootId(extension.extensionGuid)));
  for (const root of registry.listRoots()) {
    if (root.kind === "extension" && !ids.has(root.id)) registry.unmountRoot(root.id);
  }
  for (const extension of mount) {
    // Remounting rescans, so files an import or another editor changed are indexed.
    await registry.mountRoot(extensionContentRoot({
      extensionGuid: extension.extensionGuid,
      pathPrefix: extension.contentPath,
      readOnly: extension.readOnly,
      storage: options.storageFor?.(extension),
    }));
  }
}
