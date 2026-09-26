import { ENGINE_VERSION } from "@babylonslate/core";
import { stableStringify } from "./bytes";

export const EXTENSION_MANIFEST_FILE = "extension.json";
export const EXTENSIONS_DIR = "extensions";
export const EXTENSION_MANIFEST_MAX_BYTES = 256 * 1024;

export interface ExtensionDependency {
  guid: string;
  version: string;
}

/** Editor code packages are separate from runtime content Plugins. */
export interface ExtensionSettings {
  extensionGuid: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  category: string;
  iconKey: string | null;
  experimental: boolean;
  beta: boolean;
  enabledByDefault: boolean;
  engineVersion: string;
  extensionDependencies: ExtensionDependency[];
  /** One package-relative TypeScript or JavaScript module. */
  entryPoint: string;
}

/** Shared by manifests and package writes; never resolve untrusted paths first. */
export function isExtensionPackagePath(path: string): boolean {
  return path.length > 0 && !/[\\:*?"<>|]/.test(path) && ![...path].some((character) => character.charCodeAt(0) < 32) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." &&
      !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function createDefaultExtensionSettings(options: {
  extensionGuid: string;
  displayName: string;
}): ExtensionSettings {
  return {
    ...options,
    version: "1.0.0",
    description: "",
    author: "",
    category: "",
    iconKey: null,
    experimental: false,
    beta: false,
    enabledByDefault: false,
    engineVersion: ENGINE_VERSION,
    extensionDependencies: [],
    entryPoint: "index.ts",
  };
}

export function normalizeExtensionSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Extension manifest.");
  }
  const record = value as Record<string, unknown>;
  const requiredText = (key: string) => {
    const text = record[key];
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`Extension ${key} is required.`);
    }
    return text.trim();
  };
  const entryPoint = requiredText("entryPoint");
  if (!isExtensionPackagePath(entryPoint) || !/\.(?:ts|js)$/.test(entryPoint)) {
    throw new Error("Extension Entry Point must be a relative .ts or .js file.");
  }
  const dependencies: ExtensionDependency[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.extensionDependencies)) {
    for (const value of record.extensionDependencies) {
      if (!value || typeof value !== "object") continue;
      const dependency = value as Record<string, unknown>;
      const guid = typeof dependency.guid === "string" ? dependency.guid.trim() : "";
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      dependencies.push({
        guid,
        version: typeof dependency.version === "string" ? dependency.version.trim() : "",
      });
    }
  }
  return {
    extensionGuid: requiredText("extensionGuid"),
    displayName: requiredText("displayName"),
    version: requiredText("version"),
    description: typeof record.description === "string" ? record.description : "",
    author: typeof record.author === "string" ? record.author : "",
    category: typeof record.category === "string" ? record.category : "",
    iconKey: typeof record.iconKey === "string" && record.iconKey.trim() ? record.iconKey.trim() : null,
    experimental: record.experimental === true,
    beta: record.beta === true,
    enabledByDefault: record.enabledByDefault === true,
    engineVersion: typeof record.engineVersion === "string" ? record.engineVersion.trim() : "",
    extensionDependencies: dependencies,
    entryPoint,
  };
}

export function encodeExtensionSettings(settings: ExtensionSettings): Uint8Array {
  const bytes = new TextEncoder().encode(stableStringify({
    kind: "extension",
    formatVersion: 1,
    ...normalizeExtensionSettings(settings),
  }));
  if (bytes.byteLength > EXTENSION_MANIFEST_MAX_BYTES) throw new Error("Extension manifest exceeds 256 KiB.");
  return bytes;
}

export function decodeExtensionSettings(bytes: Uint8Array): ExtensionSettings {
  if (bytes.byteLength > EXTENSION_MANIFEST_MAX_BYTES) throw new Error("Extension manifest exceeds 256 KiB.");
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" ||
      (value as Record<string, unknown>).kind !== "extension" ||
      (value as Record<string, unknown>).formatVersion !== 1) {
    throw new Error("Unsupported Extension manifest.");
  }
  return normalizeExtensionSettings(value);
}
