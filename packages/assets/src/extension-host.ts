import { ENGINE_VERSION, newGuid, type ProjectStorage } from "@babylonslate/core";
import { resolvePluginGraph, type PluginDiagnostic, type PluginGraphInput } from "./plugin-host";
import {
  createDefaultExtensionSettings,
  decodeExtensionSettings,
  encodeExtensionSettings,
  EXTENSION_MANIFEST_FILE,
  EXTENSIONS_DIR,
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
}

export interface ExtensionDiagnostic {
  code: `extension.${"cycle" | "unsatisfiable" | "dependency_blocked" | "missing" | "engine_unsatisfiable"}`;
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

export function resolveExtensionEnabled(enabledByDefault: boolean, projectOverride?: boolean): boolean {
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

async function discoverExtensions(storage: ProjectStorage, source: "project" | "engine"): Promise<ExtensionDescriptor[]> {
  const root = source === "project" ? EXTENSIONS_DIR : ".";
  if (!(await storage.exists(root))) return [];
  const extensions: ExtensionDescriptor[] = [];
  for (const entry of (await storage.readdir(root)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDir) continue;
    const folderPath = source === "project" ? `${root}/${entry.name}` : entry.name;
    const manifestPath = `${folderPath}/${EXTENSION_MANIFEST_FILE}`;
    if (!(await storage.exists(manifestPath))) continue;
    const settings = decodeExtensionSettings(await storage.readBinary(manifestPath));
    if (extensions.some((extension) => extension.extensionGuid === settings.extensionGuid)) {
      throw new Error(`Duplicate Extension ID: ${settings.extensionGuid}`);
    }
    extensions.push(describeExtension(folderPath, source, settings));
  }
  return extensions;
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

/** Resolve only enabled editor modules. This deliberately never mounts runtime asset roots. */
export function resolveExtensionGraph(
  extensions: readonly ExtensionDescriptor[],
  engineVersion = ENGINE_VERSION,
  overrides: Readonly<Record<string, ExtensionEnableOverride>> = {},
): { order: ExtensionDescriptor[]; diagnostics: ExtensionDiagnostic[] } {
  const enabled = extensions.filter((extension) => resolveExtensionEnabled(
    extension.settings.enabledByDefault,
    overrides[extension.extensionGuid]?.enabled,
  ));
  const result = resolvePluginGraph(enabled.map(asPlugin), engineVersion);
  const byGuid = new Map(enabled.map((extension) => [extension.extensionGuid, extension]));
  return {
    order: result.order.map((entry) => byGuid.get(entry.pluginGuid)!),
    diagnostics: result.diagnostics.map(extensionDiagnostic),
  };
}
