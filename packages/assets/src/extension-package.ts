import { newGuid, type ProjectStorage } from "@haptic/core";
import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { encodeProjectZip, readProjectTree, writeProjectTree, type ProjectTreeFile } from "./hproject";
import { discoverEngineExtensions, discoverProjectExtensions, type ExtensionDescriptor } from "./extension-host";
import { decodeExtensionSettings, encodeExtensionSettings, EXTENSIONS_DIR, EXTENSION_MANIFEST_FILE, EXTENSION_MANIFEST_MAX_BYTES, isExtensionCodePath, isExtensionPackagePath, type ExtensionSettings } from "./extension-settings";
import { isZipArchive } from "./importers/zip-import";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_FILES = 4096;
/** Per code file (`.ts` / `.js`), entries and added files alike. */
export const EXTENSION_SOURCE_MAX_BYTES = 1024 * 1024;

export interface InspectedHextension {
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

function inspectExtensionFiles(files: ProjectTreeFile[]): InspectedHextension {
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
  if (!manifest) throw new Error("Not a .hextension: missing extension.json.");
  const settings = decodeExtensionSettings(manifest.data);
  if (!regularFiles.some((file) => file.path === settings.entryPoint)) {
    throw new Error(`Extension Entry Point is missing: ${settings.entryPoint}`);
  }
  if (!settings.editorOnly && !regularFiles.some((file) => file.path === settings.gameEntryPoint)) {
    throw new Error(`Extension Game Entry Point is missing: ${settings.gameEntryPoint}`);
  }
  for (const file of regularFiles) {
    if (isExtensionCodePath(file.path) && file.data.byteLength > EXTENSION_SOURCE_MAX_BYTES) {
      throw new Error(`Extension code file exceeds 1 MiB: ${file.path}`);
    }
  }
  return { settings, settingsPath: EXTENSION_MANIFEST_FILE, files: regularFiles };
}

/** Compressed bytes handed to the inflater at a time, so one step inflates at most about 16 MiB. */
const INFLATE_INPUT_CHUNK_BYTES = 16 * 1024;

function limitExceeded(): Error {
  return new Error("Extension package exceeds its file count or expanded size limit.");
}

/** Counts package files and checks their paths, rejecting a duplicate (case-insensitively). */
function packagePathCheck(): (name: string) => void {
  let fileCount = 0;
  const paths = new Set<string>();
  return (name) => {
    fileCount += 1;
    const folded = name.toLowerCase();
    if (!isExtensionPackagePath(name) || paths.has(folded)) {
      throw new Error(`Invalid or duplicate Extension package path: ${name}`);
    }
    paths.add(folded);
    if (fileCount > MAX_PACKAGE_FILES) throw limitExceeded();
  };
}

/**
 * The archive's files, with every limit enforced on the bytes actually
 * inflated. The sizes a ZIP declares are only a first check: the files are
 * inflated as a stream, a little compressed input at a time, and the running
 * total is counted, so a forged size cannot make the inflater run on past
 * `maxExpandedBytes`; it stops as soon as the total passes it.
 */
export function unzipExtensionArchive(bytes: Uint8Array, maxExpandedBytes = MAX_EXPANDED_BYTES): ProjectTreeFile[] {
  // Declared sizes, names and counts from the central directory reject most bad archives before anything inflates.
  const declaredPath = packagePathCheck();
  let declaredBytes = 0;
  unzipSync(bytes, { filter(file) {
    if (file.name.endsWith("/") && file.originalSize === 0) return false;
    declaredPath(file.name);
    declaredBytes += Math.max(file.originalSize, file.size);
    if (declaredBytes > maxExpandedBytes ||
        (file.name === EXTENSION_MANIFEST_FILE && file.originalSize > EXTENSION_MANIFEST_MAX_BYTES)) {
      throw limitExceeded();
    }
    return false;
  } });
  const files: ProjectTreeFile[] = [];
  const checkPath = packagePathCheck();
  let expandedBytes = 0;
  let failure: unknown = null;
  const unzip = new Unzip((file) => {
    if (failure !== null) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (failure !== null) return;
      try {
        if (error) throw error;
        size += data.byteLength;
        expandedBytes += data.byteLength;
        if (expandedBytes > maxExpandedBytes || (file.name === EXTENSION_MANIFEST_FILE && size > EXTENSION_MANIFEST_MAX_BYTES)) {
          throw limitExceeded();
        }
        chunks.push(data);
        if (!final) return;
        // A folder entry carries no data; one with data is checked as a file and refused.
        if (file.name.endsWith("/") && size === 0) return;
        checkPath(file.name);
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        files.push({ path: file.name, data: joined });
      } catch (cause) {
        failure = cause;
        file.terminate();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.byteLength && failure === null; offset += INFLATE_INPUT_CHUNK_BYTES) {
    const end = Math.min(offset + INFLATE_INPUT_CHUNK_BYTES, bytes.byteLength);
    unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
  }
  if (failure !== null) throw failure;
  return files;
}

export async function inspectHextension(bytes: Uint8Array): Promise<InspectedHextension> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Extension archive exceeds 64 MiB.");
  // iOS pickers show every file; name a wrong pick rather than fail to unzip it.
  if (!isZipArchive(bytes)) throw new Error("Not a .hextension: the file is not an Extension archive.");
  return inspectExtensionFiles(unzipExtensionArchive(bytes));
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
  incoming: InspectedHextension;
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
  incoming: InspectedHextension,
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
  const incoming = await inspectHextension(bytes);
  if (await storage.exists(folderName)) throw new Error("The Engine Extension folder already exists.");
  await writeExtensionFiles(storage, folderName, incoming.files);
  const descriptor = (await discoverEngineExtensions(storage)).find((extension) => extension.folderName === folderName);
  if (!descriptor) throw new Error("Engine Extension unpack did not produce a descriptor.");
  return descriptor;
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
    const incoming = await inspectHextension(await exportExtensionZip(engineStorage, extension));
    const folderName = uniqueExtensionFolderName(extension.folderName, folders);
    installed.push(await applyExtensionImport(projectStorage, incoming, { kind: "install", folderName }));
    guids.add(extension.extensionGuid);
    folders.push(folderName);
  }
  return installed;
}
