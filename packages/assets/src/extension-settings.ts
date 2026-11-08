import { ENGINE_VERSION } from "@haptic/core";
import { stableStringify } from "./bytes";
import { isPortablePackagePath } from "./package-path";
import { normalizeExtensionContributions, type ExtensionContributions } from "./extension-fields";

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
  /** Package-relative TypeScript or JavaScript module exporting `activate(api)` for the editor. */
  entryPoint: string;
  /** Editor-only packages never reach Play, Preview Build or exported games. */
  editorOnly: boolean;
  /** Package-relative game module; its exports become `extensions.<libraryName>` in games. */
  gameEntryPoint: string;
  /** JavaScript identifier games use to reach the game module's exports. */
  libraryName: string;
  /** Shows the mounted `assets/` root in the Content Browser tree (gameplay packages only). */
  appearInContentBrowser: boolean;
  /** Declarative editor contributions, such as a Project Settings category. */
  contributes: ExtensionContributions;
}

/** Shared by manifests and package writes; never resolve untrusted paths first. */
export const isExtensionPackagePath = isPortablePackagePath;

/** Folder inside a package for added code files. */
export const EXTENSION_CODE_DIR = "code";
export const DEFAULT_EXTENSION_GAME_ENTRY_POINT = "game.ts";

const LIBRARY_NAME = /^[A-Za-z_$][\w$]*$/;

export function isExtensionLibraryName(value: string): boolean {
  return LIBRARY_NAME.test(value);
}

/** TypeScript or JavaScript source inside a package (never under its `assets/` root). */
export function isExtensionCodePath(path: string): boolean {
  return isExtensionPackagePath(path) && /\.(?:ts|js)$/.test(path) && !/^assets(?:\/|$)/i.test(path);
}

/** camelCase identifier from a display name: "GLSL to Material" -> "glslToMaterial". */
export function defaultExtensionLibraryName(displayName: string): string {
  const words = displayName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((word, index) => index === 0
    ? word.toLowerCase()
    : word[0]!.toUpperCase() + word.slice(1)).join("");
  if (!name) return "extension";
  return /^[0-9]/.test(name) ? `_${name}` : name;
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
    editorOnly: true,
    gameEntryPoint: DEFAULT_EXTENSION_GAME_ENTRY_POINT,
    libraryName: defaultExtensionLibraryName(options.displayName),
    appearInContentBrowser: false,
    contributes: {},
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
  if (!isExtensionCodePath(entryPoint)) {
    throw new Error("Extension Entry Point must be a relative .ts or .js file.");
  }
  const gameEntryPoint = typeof record.gameEntryPoint === "string" && record.gameEntryPoint.trim()
    ? record.gameEntryPoint.trim() : DEFAULT_EXTENSION_GAME_ENTRY_POINT;
  if (!isExtensionCodePath(gameEntryPoint)) {
    throw new Error("Extension Game Entry Point must be a relative .ts or .js file.");
  }
  if (gameEntryPoint.toLowerCase() === entryPoint.toLowerCase()) {
    throw new Error("Extension Game Entry Point must differ from its Entry Point.");
  }
  const displayName = requiredText("displayName");
  const libraryName = typeof record.libraryName === "string" && record.libraryName.trim()
    ? record.libraryName.trim() : defaultExtensionLibraryName(displayName);
  if (!isExtensionLibraryName(libraryName)) {
    throw new Error("Extension Library Name must be a JavaScript identifier.");
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
    displayName,
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
    editorOnly: record.editorOnly !== false,
    gameEntryPoint,
    libraryName,
    appearInContentBrowser: record.appearInContentBrowser === true,
    contributes: normalizeExtensionContributions(record.contributes),
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
