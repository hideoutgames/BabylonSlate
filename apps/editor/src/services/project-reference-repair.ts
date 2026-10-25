import { isLockedEngineClassId } from "@haptic/object-model";
import {
  documentKindForAssetType,
  PROJECT_FILE,
  type DocumentKind,
  type ProjectDocument,
  type ProjectStorage,
  type SerializedGraph,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@haptic/core";
import {
  clearDeletedAssetRefs,
  createReadAhead,
  fallbackParentClass,
  isTracePath,
  renamedAssetPath,
  replaceClassAssetReferences,
  type AssetRegistry,
  type ClassAssetReplacement,
  type IndexedAsset,
  type PluginDescriptor,
} from "@haptic/assets";
import { validateClassDeletionReplacements } from "../lib/class-deletion";
import { classIdFromClassAsset } from "../lib/content-browser-helpers";
import { isPluginDocumentReadOnly } from "../lib/plugin-ui";
import type { ProjectService } from "./project-service";

/** Stored payloads requested at once by a delete repair: the document being repaired plus the three after it. */
const DELETE_REPAIR_READS = 4;

type StoredDocument = { type: string; version: number; payload: Record<string, unknown> };
type DocumentContent = Awaited<ReturnType<ProjectService["loadDocument"]>>;

/** The project reads and writes that rewrite references across its assets. */
export interface ReferenceRepairHost extends Pick<ProjectService, "loadDocument" | "saveDocument" | "remountRegistry"> {
  readonly storage: ProjectStorage;
  registry(): AssetRegistry | null;
  plugins(): readonly PluginDescriptor[];
  storageFor(path: string): ProjectStorage;
  /** The stored payload `loadDocument` starts from, without migration bookkeeping. */
  readStoredAssetDocument(kind: Exclude<DocumentKind, "content-browser">, path: string): Promise<StoredDocument>;
  /** What `loadDocument` makes of a stored payload. */
  documentContent(kind: Exclude<DocumentKind, "content-browser">, path: string, raw: StoredDocument): DocumentContent;
}

async function planClassReferenceReplacements(
  host: ReferenceRepairHost,
  replacements: readonly ClassAssetReplacement[],
  deletingGuids: ReadonlySet<string>,
  onProgress?: (path: string) => Promise<void>,
) {
  const registry = host.registry();
  if (!registry) throw new Error("The asset registry is unavailable.");
  const assets = registry.list();
  const plans: Array<{
    kind: Exclude<DocumentKind, "content-browser">;
    path: string;
    content: DocumentContent;
    parentClass: string | null;
  }> = [];
  for (const asset of assets) {
    if (deletingGuids.has(asset.header.guid)) continue;
    const kind = documentKindForAssetType(asset.header.type);
    if (!kind || kind === "trace") continue;
    await onProgress?.(asset.path);
    const content = await host.loadDocument(kind, asset.path);
    const walked = replaceClassAssetReferences(content, replacements, (guid) => {
      const payload = registry.getByGuid(guid)?.header;
      return payload && ["DataDefinition", "Structure"].includes(payload.type) && Array.isArray(payload.payload.fields) ? payload.payload.fields : undefined;
    });
    const header = replaceClassAssetReferences({
      parentClass: asset.header.parentClass ?? null,
      dependencies: asset.header.dependencies,
    }, replacements);
    if (!walked.changed && !header.changed) continue;
    if (registry.getRoot(asset.rootId)?.readOnly || isPluginDocumentReadOnly(host.plugins(), asset.path)) {
      throw new Error(`${asset.path} is read-only and still references a selected Class.`);
    }
    plans.push({ kind, path: asset.path, content: walked.value, parentClass: header.value.parentClass });
  }
  return plans;
}

/** Validate all referrers before writing replacements; never delete a Class here. */
export async function replaceClassReferencesBeforeDelete(
  host: ReferenceRepairHost,
  replacements: readonly ClassAssetReplacement[],
  deletingGuids: ReadonlySet<string>,
  onProgress?: (path: string) => Promise<void>,
): Promise<void> {
  const registry = host.registry();
  if (!registry) throw new Error("The asset registry is unavailable.");
  validateClassDeletionReplacements(replacements, registry.list(), deletingGuids);
  const plans = await planClassReferenceReplacements(host, replacements, deletingGuids, onProgress);
  // Like a Class rename, the referrers are rewritten together or not at all.
  const backups = await Promise.all(plans.map(async (plan) => ({
    path: plan.path,
    storage: host.storageFor(plan.path),
    bytes: await host.storageFor(plan.path).readBinary(plan.path),
  })));
  let attempted = 0;
  try {
    for (const plan of plans) {
      await onProgress?.(plan.path);
      attempted += 1;
      await host.saveDocument(plan.kind, plan.path, plan.content, { parentClass: plan.parentClass });
    }
  } catch (error) {
    const failures: string[] = [];
    for (const backup of backups.slice(0, attempted)) {
      try { await backup.storage.writeBinary(backup.path, backup.bytes); }
      catch { failures.push(backup.path); }
    }
    try { await host.remountRegistry(); }
    catch { failures.push("Asset Registry"); }
    if (failures.length) throw new Error(`Replacing Class references failed and some files could not be restored: ${failures.join(", ")}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw error;
  }
}

/** Rename a Class and its name-based referrers as one recoverable file operation. */
export async function renameAsset(host: ReferenceRepairHost, guid: string, newName: string, options?: {
  /** Validate locks and persist recovery before any files change. */
  beforeWrite?: (paths: string[]) => Promise<void>;
}): Promise<IndexedAsset> {
  const registry = host.registry();
  const before = registry?.getByGuid(guid);
  if (!registry || !before) throw new Error("The asset is unavailable.");
  const nextPath = renamedAssetPath(before.path, newName);
  if (nextPath !== before.path && registry.getByPath(nextPath)) {
    throw new Error(`Target path already exists: ${nextPath}`);
  }
  if (before.header.type !== "Class") {
    await options?.beforeWrite?.([before.path, nextPath]);
    return registry.renameAsset(guid, newName);
  }
  const classId = classIdFromClassAsset(before);
  const nextClassId = classIdFromClassAsset({ ...before, path: nextPath });
  if (classId === nextClassId) {
    await options?.beforeWrite?.([before.path, nextPath]);
    return registry.renameAsset(guid, newName);
  }
  if (isLockedEngineClassId(nextClassId)) {
    throw new Error(`"${nextClassId}" is an engine class name. Choose another Class name.`);
  }
  if (registry.list().some((asset) => asset.header.guid !== guid &&
    asset.header.type === "Class" && classIdFromClassAsset(asset) === nextClassId)) {
    throw new Error("A Class with that name already exists.");
  }
  const replacements = [{ guid, classId, replacement: { guid, classId: nextClassId } }];
  const plans = await planClassReferenceReplacements(host, replacements, new Set());
  const backups = await Promise.all(plans.map(async (plan) => ({
    path: plan.path,
    storage: host.storageFor(plan.path),
    bytes: await host.storageFor(plan.path).readBinary(plan.path),
  })));
  const original = await host.storageFor(before.path).readBinary(before.path);
  const projectText = await host.storage.readText(PROJECT_FILE);
  const project = JSON.parse(projectText) as ProjectDocument;
  const settings = replaceClassAssetReferences(project.settings, replacements);
  await options?.beforeWrite?.([before.path, nextPath, ...plans.map((plan) => plan.path), ...(settings.changed ? [PROJECT_FILE] : [])]);
  const renamed = await registry.renameAsset(guid, newName);
  try {
    for (const plan of plans) {
      await host.saveDocument(plan.kind, plan.path === before.path ? renamed.path : plan.path, plan.content, { parentClass: plan.parentClass });
    }
    if (settings.changed) await host.storage.writeText(PROJECT_FILE, JSON.stringify({ ...project, settings: settings.value }, null, 2));
    return registry.getByGuid(guid)!;
  } catch (error) {
    // A persistent storage failure must not prevent attempts to restore the
    // other files. Retain both Class copies if its original cannot be restored.
    const failures: string[] = [];
    const restore = async (path: string, write: () => Promise<void>) => {
      try { await write(); return true; }
      catch { failures.push(path); return false; }
    };
    const storage = host.storageFor(renamed.path);
    const sourceRestored = await restore(before.path, () => storage.writeBinary(before.path, original));
    for (const backup of backups) {
      if (backup.path !== before.path) await restore(backup.path, () => backup.storage.writeBinary(backup.path, backup.bytes));
    }
    if (sourceRestored && renamed.path !== before.path) await restore(renamed.path, () => storage.remove(renamed.path));
    await restore(PROJECT_FILE, () => host.storage.writeText(PROJECT_FILE, projectText));
    await restore("Asset Registry", () => host.remountRegistry().then(() => {}));
    if (failures.length) throw new Error(`Class rename failed and some files could not be restored: ${failures.join(", ")}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw error;
  }
}

/** See `ProjectService.clearDeletedAssetReferences`. */
export async function clearDeletedAssetReferences(
  host: ReferenceRepairHost,
  deletedGuids: ReadonlySet<string>,
  options: {
    deletedClassNames?: ReadonlySet<string>;
    onProgress?: (path: string) => Promise<void>;
  } = {},
): Promise<Array<{ path: string; error: unknown }>> {
  const registry = host.registry();
  const deletedClassNames = options.deletedClassNames ?? new Set();
  if (!registry) return [];
  if (deletedGuids.size === 0 && deletedClassNames.size === 0) return [];

  const failed: Array<{ path: string; error: unknown }> = [];
  const assets = registry.list();
  // The walk replaces any string equal to a deleted guid, wherever a document keeps it, so the
  // typed dependency metadata in the headers cannot say which documents are unaffected: every
  // writable document is still read. The stored payloads of the next few are requested while one
  // is repaired; migration bookkeeping, the walk and the save stay one document at a time, in
  // catalog order, since a save changes the headers the next walk consults.
  const repairable = assets.filter((asset) => {
    const kind = documentKindForAssetType(asset.header.type);
    return kind && kind !== "trace" && !isTracePath(asset.path) && !deletedGuids.has(asset.header.guid)
      && !registry.getRoot(asset.rootId)?.readOnly && !isPluginDocumentReadOnly(host.plugins(), asset.path);
  });
  const repairableIndex = new Map(repairable.map((asset, index) => [asset, index] as const));
  const readStored = createReadAhead(DELETE_REPAIR_READS, (asset: IndexedAsset) =>
    host.readStoredAssetDocument(documentKindForAssetType(asset.header.type)!, asset.path));
  for (const asset of assets) {
    if (deletedGuids.has(asset.header.guid)) continue;
    const root = registry.getRoot(asset.rootId);
    if (root?.readOnly) continue;
    if (isPluginDocumentReadOnly(host.plugins(), asset.path)) continue;
    const kind = documentKindForAssetType(asset.header.type);
    if (!kind) continue;

    await options.onProgress?.(asset.path);

    let content:
      | SerializedScene
      | SerializedSceneLayer
      | SerializedGraph
      | Record<string, unknown>;
    try {
      const position = repairableIndex.get(asset);
      let stored: StoredDocument | undefined;
      if (position !== undefined) {
        // A save that syncs plugins unmounts and remounts their roots, which can fail a read
        // that was already in flight for a plugin document. Such a document is read again, as
        // a serial pass would have read it now, before it is given up on.
        try { stored = await readStored(repairable, position); }
        catch { stored = undefined; }
      }
      content = stored
        ? host.documentContent(kind, asset.path, stored)
        : await host.loadDocument(kind, asset.path);
    } catch {
      continue;
    }
    const walked = clearDeletedAssetRefs(
      content,
      deletedGuids,
      deletedClassNames,
      (guid) => {
        const header = registry.getByGuid(guid)?.header;
        return header && ["DataDefinition", "Structure"].includes(header.type) && Array.isArray(header.payload.fields) ? header.payload.fields : undefined;
      },
    );
    const isClass = asset.header.type === "Class";
    const nextParent = isClass
      ? fallbackParentClass(asset.header.parentClass, deletedClassNames)
      : undefined;
    const parentChanged =
      nextParent !== undefined &&
      nextParent !== (asset.header.parentClass ?? null);
    if (!walked.changed && !parentChanged) continue;
    try {
      await host.saveDocument(
        kind,
        asset.path,
        walked.value,
        parentChanged ? { parentClass: nextParent } : undefined,
      );
    } catch (error) {
      // A pending migration or a write error keeps the dangling reference.
      failed.push({ path: asset.path, error });
    }
  }
  return failed;
}
