import { ENGINE_VERSION } from "@babylonslate/core";
import { encodeAssetDocument } from "./asset-document";

export const PLUGIN_SETTINGS_TYPE = "PluginSettings";
export const PLUGIN_FILE_SUFFIX = ".plugin.babasset";

export interface PluginDependency {
  guid: string;
  /** Installed author version recorded when the dependency is selected. */
  version: string;
}

export interface PluginSettingsPayload {
  displayName: string;
  pluginGuid: string;
  version: string;
  description: string;
  author: string;
  category: string;
  iconKey: string | null;
  experimental: boolean;
  beta: boolean;
  editorUtilityObjects: string[];
  enabledByDefault: boolean;
  /** Engine version recorded at creation; reading/importing never updates it. */
  engineVersion: string;
  pluginDependencies: PluginDependency[];
}

export function createDefaultPluginSettings(options: {
  pluginGuid: string;
  displayName: string;
}): PluginSettingsPayload {
  return {
    displayName: options.displayName,
    pluginGuid: options.pluginGuid,
    version: "1.0.0",
    description: "",
    author: "",
    category: "",
    iconKey: null,
    experimental: false,
    beta: false,
    editorUtilityObjects: [],
    enabledByDefault: false,
    engineVersion: ENGINE_VERSION,
    pluginDependencies: [],
  };
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeDependencies(value: unknown): PluginDependency[] {
  if (!Array.isArray(value)) return [];
  const deps: PluginDependency[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const guid = typeof record.guid === "string" ? record.guid.trim() : "";
    const version = typeof record.version === "string" ? record.version.trim() : "";
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    deps.push({ guid, version });
  }
  return deps;
}

export function normalizePluginSettings(
  value: unknown,
  fallback: { pluginGuid: string; displayName?: string },
): PluginSettingsPayload {
  const source = (value ?? {}) as Record<string, unknown>;
  const displayName =
    typeof source.displayName === "string" && source.displayName.trim() !== ""
      ? source.displayName.trim()
      : (fallback.displayName ?? "Plugin");
  const version =
    typeof source.version === "string" && source.version.trim() !== ""
      ? source.version.trim()
      : "1.0.0";
  const iconKey =
    typeof source.iconKey === "string" && source.iconKey.trim() !== ""
      ? source.iconKey.trim()
      : null;
  return {
    displayName,
    pluginGuid: fallback.pluginGuid,
    version,
    description: typeof source.description === "string" ? source.description : "",
    author: typeof source.author === "string" ? source.author : "",
    category: typeof source.category === "string" ? source.category : "",
    iconKey,
    experimental: source.experimental === true,
    beta: source.beta === true,
    editorUtilityObjects: uniqueIds(source.editorUtilityObjects),
    enabledByDefault: source.enabledByDefault === true,
    engineVersion:
      typeof source.engineVersion === "string" ? source.engineVersion.trim() : "",
    pluginDependencies: normalizeDependencies(source.pluginDependencies),
  };
}

export async function encodePluginSettingsDocument(
  settings: PluginSettingsPayload,
): Promise<Uint8Array> {
  return encodeAssetDocument(
    {
      type: PLUGIN_SETTINGS_TYPE,
      name: settings.displayName,
      guid: settings.pluginGuid,
      version: 1,
      payload: { ...settings },
    },
    { engineVersion: ENGINE_VERSION },
  );
}
