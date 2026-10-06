import type { GraphClassMember } from "@babylonslate/core";
import { ASSET_DEPENDENCY_METADATA_VERSION, collectAssetDependencyMetadata, type AssetDependencyClass, type AssetDependencyContext } from "./asset-dependencies";
import { BABASSET_PREFIX_BYTES, readBabassetHeader, readBabassetHeaderLength } from "./babasset";
import { concatBytes, sha256Hex, stableStringify, writeU32LE } from "./bytes";
import type { AssetRegistry, IndexedAsset } from "./registry";

export interface DependencyMetadataUpgradeOptions {
  /** Omit for all legacy assets in writable content roots. */
  guids?: readonly string[];
  signal?: AbortSignal;
  context?: AssetDependencyContext;
  onProgress?: (progress: { completed: number; total: number; guid: string }) => void;
}

/** Metadata-only inspection. Calling this never reads document/source bytes. */
export function assetsNeedingDependencyMetadataUpgrade(assets: readonly IndexedAsset[]): IndexedAsset[] {
  return assets.filter(asset => !asset.placeholder && (
    asset.header.dependencyMetadataVersion !== ASSET_DEPENDENCY_METADATA_VERSION || !asset.header.requiredDependencies
  ));
}

function classId(asset: IndexedAsset): string {
  return (asset.path.split("/").pop() ?? asset.path)
    .replace(/\.(graph|class)\.(babasset|json)$/, "")
    .replace(/\.babasset$/, "").replace(/[^A-Za-z0-9_]+/g, "_") || "Graph";
}

/**
 * An explicit, versioned maintenance operation, never invoked by catalog scans.
 * It reads documents to rebuild typed relationships. The file rewrite preserves
 * every original inline byte and external chunk locator/hash without decoding
 * or fetching model, audio, font or texture blobs.
 */
export async function upgradeAssetDependencyMetadata(registry: AssetRegistry, options: DependencyMetadataUpgradeOptions = {}): Promise<{ upgraded: string[]; readOnly: string[] }> {
  const catalog = registry.list();
  const selected = options.guids ? new Set(options.guids) : undefined;
  if (selected) for (const guid of selected) if (!catalog.some(asset => asset.header.guid === guid)) throw new Error(`Cannot upgrade missing asset ${guid}`);
  const pending = assetsNeedingDependencyMetadataUpgrade(catalog).filter(asset => !selected || selected.has(asset.header.guid));
  const readOnly = pending.filter(asset => registry.getRoot(asset.rootId)?.readOnly).map(asset => asset.header.guid);
  const writable = pending.filter(asset => !registry.getRoot(asset.rootId)?.readOnly);
  for (const asset of pending) if ((asset.header.dependencyMetadataVersion ?? 0) > ASSET_DEPENDENCY_METADATA_VERSION) {
    throw new Error(`Asset ${asset.header.guid} uses newer dependency metadata; update BabylonSlate before upgrading this project`);
  }
  if (!writable.length) return { upgraded: [], readOnly };
  const classes: AssetDependencyClass[] = [];
  const definitions = new Map<string, readonly unknown[]>();
  // Only this explicit upgrade may fill missing legacy schemas from documents.
  // Schema documents are small; scene/source documents are consumed one at a time.
  for (const asset of catalog) {
    options.signal?.throwIfAborted();
    if (!["Class", "Graph", "DataDefinition", "Structure"].includes(asset.header.type)) continue;
    const document = await registry.readAssetDocument(asset.header.guid);
    if (asset.header.type === "Class" || asset.header.type === "Graph") classes.push({
      guid: asset.header.guid, classId: classId(asset), parentClassId: asset.header.parentClass,
      members: Array.isArray(document.payload.members) ? document.payload.members as GraphClassMember[] : [],
    });
    else if (Array.isArray(document.payload.fields)) definitions.set(asset.header.guid, document.payload.fields);
  }
  const upgraded: string[] = [];
  for (const asset of writable) {
    options.signal?.throwIfAborted();
    await registry.withAssetWrite(asset.header.guid, async () => {
      const current = registry.getByGuid(asset.header.guid);
      if (!current) throw new Error(`Asset ${asset.header.guid} disappeared during dependency metadata upgrade`);
      const storage = registry.storageFor(current.rootId);
      const prefix = await storage.readBinaryRange(current.path, 0, BABASSET_PREFIX_BYTES);
      const snapshot = await storage.readBinaryRange(current.path, 0, prefix.totalSize, prefix.revision);
      const header = readBabassetHeader(snapshot.bytes);
      const body = header.chunks.find(chunk => chunk.id === "document");
      let payload = header.payload;
      if (body) {
        const bytes = "blob" in body.locator ? await registry.blobsFor(current.rootId).readBlob(body.locator.blob)
          : snapshot.bytes.subarray(BABASSET_PREFIX_BYTES + readBabassetHeaderLength(snapshot.bytes) + body.locator.inline.offset,
            BABASSET_PREFIX_BYTES + readBabassetHeaderLength(snapshot.bytes) + body.locator.inline.offset + body.locator.inline.length);
        if (await sha256Hex(bytes) !== body.sha256) throw new Error(`Document hash mismatch while upgrading asset ${header.guid}`);
        payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      }
      const metadata = collectAssetDependencyMetadata(header.type, payload, {
        ...options.context,
        dependencies: header.dependencies,
        parentClass: header.parentClass,
        classes: [...classes, ...(options.context?.classes ?? [])],
        definitionFields: guid => definitions.get(guid) ?? options.context?.definitionFields?.(guid),
      });
      const headerBytes = new TextEncoder().encode(stableStringify({ ...header, ...metadata }));
      const bytes = concatBytes([
        snapshot.bytes.subarray(0, 8), writeU32LE(headerBytes.byteLength), headerBytes,
        snapshot.bytes.subarray(BABASSET_PREFIX_BYTES + readBabassetHeaderLength(snapshot.bytes)),
      ]);
      options.signal?.throwIfAborted();
      // Recheck after document reads, which may yield while another editor saves.
      await storage.readBinaryRange(current.path, 0, BABASSET_PREFIX_BYTES, snapshot.revision);
      await storage.writeBinary(current.path, bytes);
      await registry.reindexPath(current.path);
    });
    upgraded.push(asset.header.guid);
    options.onProgress?.({ completed: upgraded.length, total: writable.length, guid: asset.header.guid });
  }
  return { upgraded, readOnly };
}
