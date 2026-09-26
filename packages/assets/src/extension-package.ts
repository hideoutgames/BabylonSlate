import { newGuid, type ProjectStorage } from "@babylonslate/core";
import { unzipSync } from "fflate";
import { encodeProjectZip, readProjectTree, writeProjectTree, type ProjectTreeFile } from "./babproject";
import { discoverEngineExtensions, discoverProjectExtensions, type ExtensionDescriptor } from "./extension-host";
import { decodeExtensionSettings, encodeExtensionSettings, EXTENSIONS_DIR, EXTENSION_MANIFEST_FILE, EXTENSION_MANIFEST_MAX_BYTES, isExtensionPackagePath, type ExtensionSettings } from "./extension-settings";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_FILES = 4096;
const MAX_SOURCE_BYTES = 1024 * 1024;

export interface InspectedBabextension {
  settings: ExtensionSettings;
  settingsPath: typeof EXTENSION_MANIFEST_FILE;
  files: ProjectTreeFile[];
}

export type ExtensionImportPlan =
  | { kind: "install"; folderName: string }
  | { kind: "update"; folderName: string; existingGuid: string }
  | { kind: "conflict"; folderName: string; existingGuid: string; version: string; replace?: boolean }
  | { kind: "remap-extension"; folderName: string; previousGuid: string; nextGuid: string };

export function uniqueExtensionFolderName(displayName: string, existingFolderNames: readonly string[]): string {
  const base = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "extension";
  const used = new Set(existingFolderNames.map((name) => name.toLowerCase()));
  if (!used.has(base)) return base;
  let index = 1;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function inspectExtensionFiles(files: ProjectTreeFile[]): InspectedBabextension {
  const seen = new Set<string>();
  const regularFiles = files.filter((file) => !file.path.endsWith("/") || file.data.length > 0);
  if (regularFiles.length > MAX_PACKAGE_FILES ||
      regularFiles.reduce((total, file) => total + file.data.byteLength, 0) > MAX_EXPANDED_BYTES) {
    throw new Error("Extension package exceeds its file count or expanded size limit.");
  }
  for (const file of regularFiles) {
    const folded = file.path.toLowerCase();
    if (!isExtensionPackagePath(file.path) || folded === "assets" || seen.has(folded)) {
      throw new Error(`Invalid or duplicate Extension package path: ${file.path}`);
    }
    seen.add(folded);
  }
  // A file cannot also be an ancestor directory, including on case-insensitive hosts.
  for (const path of seen) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      if (seen.has(parts.slice(0, count).join("/"))) {
        throw new Error(`Conflicting Extension package path: ${path}`);
      }
    }
  }
  const manifest = regularFiles.find((file) => file.path === EXTENSION_MANIFEST_FILE);
  if (!manifest) throw new Error("Not a .babextension: missing extension.json.");
  const settings = decodeExtensionSettings(manifest.data);
  if (!regularFiles.some((file) => file.path === settings.entryPoint)) {
    throw new Error(`Extension Entry Point is missing: ${settings.entryPoint}`);
  }
  if (regularFiles.find((file) => file.path === settings.entryPoint)!.data.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("Extension Entry Point exceeds 1 MiB.");
  }
  return { settings, settingsPath: EXTENSION_MANIFEST_FILE, files: regularFiles };
}

export async function inspectBabextension(bytes: Uint8Array): Promise<InspectedBabextension> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Extension archive exceeds 64 MiB.");
  let expandedBytes = 0;
  let fileCount = 0;
  const paths = new Set<string>();
  const decoded = unzipSync(bytes, { filter(file) {
    if (file.name.endsWith("/") && file.originalSize === 0) return false;
    fileCount += 1;
    expandedBytes += Math.max(file.originalSize, file.size);
    const folded = file.name.toLowerCase();
    if (!isExtensionPackagePath(file.name) || paths.has(folded)) {
      throw new Error(`Invalid or duplicate Extension package path: ${file.name}`);
    }
    paths.add(folded);
    if (fileCount > MAX_PACKAGE_FILES || expandedBytes > MAX_EXPANDED_BYTES ||
        (file.name === EXTENSION_MANIFEST_FILE && file.originalSize > EXTENSION_MANIFEST_MAX_BYTES)) {
      throw new Error("Extension package exceeds its file count or expanded size limit.");
    }
    return true;
  } });
  return inspectExtensionFiles(Object.entries(decoded).map(([path, data]) => ({ path, data })));
}

export async function exportExtensionZip(storage: ProjectStorage, descriptor: ExtensionDescriptor): Promise<Uint8Array> {
  if (descriptor.invalid) throw new Error(`The Extension is invalid: ${descriptor.invalid}`);
  const prefix = `${descriptor.folderPath}/`;
  const files = (await readProjectTree(storage, descriptor.folderPath)).map((file) => ({
    path: file.path.slice(prefix.length),
    data: file.path === descriptor.settingsPath ? encodeExtensionSettings(descriptor.settings) : file.data,
  }));
  return encodeProjectZip(inspectExtensionFiles(files).files);
}

export function planExtensionImport(options: {
  incoming: InspectedBabextension;
  existingExtensions: readonly ExtensionDescriptor[];
  occupiedGuids: ReadonlySet<string>;
  existingFolderNames: readonly string[];
  createGuid?: () => string;
}): ExtensionImportPlan {
  const guid = options.incoming.settings.extensionGuid;
  const existing = options.existingExtensions.find((extension) => extension.extensionGuid === guid);
  if (existing) {
    return existing.settings.version === options.incoming.settings.version
      ? { kind: "conflict", folderName: existing.folderName, existingGuid: guid, version: existing.settings.version }
      : { kind: "update", folderName: existing.folderName, existingGuid: guid };
  }
  const folderName = uniqueExtensionFolderName(options.incoming.settings.displayName, options.existingFolderNames);
  return options.occupiedGuids.has(guid)
    ? { kind: "remap-extension", folderName, previousGuid: guid, nextGuid: (options.createGuid ?? newGuid)() }
    : { kind: "install", folderName };
}

function validateFolderName(folderName: string): void {
  if (!isExtensionPackagePath(folderName) || folderName.includes("/")) {
    throw new Error("Invalid Extension folder name.");
  }
}

async function writeExtensionFiles(storage: ProjectStorage, folderPath: string, files: ProjectTreeFile[]): Promise<void> {
  await storage.mkdir(`${folderPath}/assets`, true);
  await writeProjectTree(storage, files.map((file) => ({ ...file, path: `${folderPath}/${file.path}` })));
}

export async function applyExtensionImport(
  storage: ProjectStorage,
  incoming: InspectedBabextension,
  plan: ExtensionImportPlan,
): Promise<ExtensionDescriptor> {
  validateFolderName(plan.folderName);
  const checked = inspectExtensionFiles(incoming.files);
  if (plan.kind === "conflict" && !plan.replace) throw new Error("Extension import conflict was not replaced.");
  const folderPath = `${EXTENSIONS_DIR}/${plan.folderName}`;
  const replace = plan.kind === "update" || plan.kind === "conflict";
  const exists = await storage.exists(folderPath);
  if (exists && !replace) throw new Error("The Extension folder already exists.");
  const backup = exists ? await readProjectTree(storage, folderPath) : [];
  const settings = plan.kind === "remap-extension" ? {
    ...checked.settings,
    extensionGuid: plan.nextGuid,
    extensionDependencies: checked.settings.extensionDependencies.map((dependency) => ({
      ...dependency,
      guid: dependency.guid === plan.previousGuid ? plan.nextGuid : dependency.guid,
    })),
  } : checked.settings;
  const files = checked.files.map((file) => file.path === EXTENSION_MANIFEST_FILE
    ? { ...file, data: encodeExtensionSettings(settings) }
    : file);
  if (exists) await storage.remove(folderPath);
  try {
    await writeExtensionFiles(storage, folderPath, files);
  } catch (error) {
    if (await storage.exists(folderPath)) await storage.remove(folderPath);
    if (exists) await writeProjectTree(storage, backup);
    throw error;
  }
  const descriptor = (await discoverProjectExtensions(storage)).find((extension) => extension.folderName === plan.folderName);
  if (!descriptor) throw new Error("Extension import did not produce a descriptor.");
  return descriptor;
}

export async function unpackEngineExtensionZip(storage: ProjectStorage, bytes: Uint8Array, folderName: string): Promise<ExtensionDescriptor> {
  validateFolderName(folderName);
  const incoming = await inspectBabextension(bytes);
  if (await storage.exists(folderName)) throw new Error("The Engine Extension folder already exists.");
  await writeExtensionFiles(storage, folderName, incoming.files);
  const descriptor = (await discoverEngineExtensions(storage)).find((extension) => extension.folderName === folderName);
  if (!descriptor) throw new Error("Engine Extension unpack did not produce a descriptor.");
  return descriptor;
}

export async function packEngineExtensionFiles(
  files: ProjectTreeFile[],
  options: { id: string },
): Promise<{ zip: Uint8Array; indexEntry: { id: string; file: string } }> {
  validateFolderName(options.id);
  return {
    zip: encodeProjectZip(inspectExtensionFiles(files).files),
    indexEntry: { id: options.id, file: `${options.id}.babextension` },
  };
}

/** New projects receive independent editable copies, preserving source and asset GUIDs. */
export async function installEngineExtensionDefaults(projectStorage: ProjectStorage, engineStorage: ProjectStorage): Promise<ExtensionDescriptor[]> {
  const existing = await discoverProjectExtensions(projectStorage);
  const guids = new Set(existing.map((extension) => extension.extensionGuid));
  const folders = existing.map((extension) => extension.folderName);
  const installed: ExtensionDescriptor[] = [];
  for (const extension of await discoverEngineExtensions(engineStorage)) {
    if (extension.invalid) continue;
    if (guids.has(extension.extensionGuid)) continue;
    const incoming = await inspectBabextension(await exportExtensionZip(engineStorage, extension));
    const folderName = uniqueExtensionFolderName(extension.folderName, folders);
    installed.push(await applyExtensionImport(projectStorage, incoming, { kind: "install", folderName }));
    guids.add(extension.extensionGuid);
    folders.push(folderName);
  }
  return installed;
}
