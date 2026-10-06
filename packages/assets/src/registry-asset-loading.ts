import { DOCUMENT_CHUNK_ID, type AssetDocument } from "./asset-document";
import { SourceRevisionChangedError, type StorageReadOptions } from "@babylonslate/core";
import {
  AssetLoadingService,
  type AssetCatalogRecord,
  type AssetLoadingBudgets,
  type AssetRepresentation,
} from "./asset-loading-service";
import type { AssetRegistry, IndexedAsset } from "./registry";

export interface RegistryLoadedAsset {
  revision: string;
  document: AssetDocument;
  /** Contains only the document and the representation's selected chunks. */
  chunks: ReadonlyMap<string, Uint8Array>;
}

export interface RegistryAssetLoadingOptions {
  projectId: string;
  budgets?: Partial<AssetLoadingBudgets>;
  /** Select a compatible representation before reading any source bytes. */
  selectChunks?: (asset: IndexedAsset) => readonly string[];
  /** A host that already owns the document can acquire binary chunks separately. */
  includeDocument?: boolean;
  /** Include representation settings; chunk IDs are additionally part of the key. */
  representationKey?: string | ((asset: IndexedAsset) => string);
  /** Remove host-owned source-map entries or object URLs on eviction. */
  onDispose?: (asset: IndexedAsset, value: RegistryLoadedAsset) => void;
}

interface RegistryRecord extends AssetCatalogRecord {
  indexed: IndexedAsset;
  chunkIds: readonly string[];
  sourceBytes: number;
  documentBytes: number;
}

/**
 * Metadata-only catalog adapter shared by project hosts. The default prepares
 * authored documents. Hosts select model/audio/texture chunks explicitly using
 * their existing representation rules instead of loading every derived variant.
 */
export function createRegistryAssetLoadingService(
  registry: AssetRegistry | (() => AssetRegistry),
  options: RegistryAssetLoadingOptions,
): AssetLoadingService {
  const currentRegistry = () => typeof registry === "function" ? registry() : registry;
  return new AssetLoadingService({
    projectId: options.projectId,
    budgets: options.budgets,
    resolve: (id, signal) => registryRecord(currentRegistry(), id, options, { signal }),
    representation: (asset) => representationForRecord(currentRegistry(), asset as RegistryRecord, options),
  });
}

/** Prepare a selected source representation for an existing shared service/scope. */
export async function registryAssetRepresentation(
  registry: AssetRegistry,
  id: string,
  options: Omit<RegistryAssetLoadingOptions, "projectId" | "budgets"> = {},
  readOptions?: StorageReadOptions,
): Promise<AssetRepresentation<RegistryLoadedAsset>> {
  return representationForRecord(registry, await registryRecord(registry, id, options, readOptions), options);
}

async function registryRecord(
  registry: AssetRegistry,
  id: string,
  options: Pick<RegistryAssetLoadingOptions, "selectChunks" | "includeDocument">,
  readOptions?: StorageReadOptions,
): Promise<RegistryRecord> {
  const locator = await registry.getAssetLocator(id, readOptions);
  const indexed = registry.getByGuid(id);
  if (!indexed || indexed.placeholder) throw new Error(`Missing asset ${id}`);
  const documentEntry = indexed.header.chunks.find((entry) => entry.id === DOCUMENT_CHUNK_ID);
  const chunkIds = [...new Set([
    ...(documentEntry && options.includeDocument !== false ? [DOCUMENT_CHUNK_ID] : []),
    ...(options.selectChunks?.(indexed) ?? []),
  ])];
  const lengths = await Promise.all(chunkIds.map((chunkId) => registry.getChunkByteLength(id, chunkId, locator.revision, readOptions)));
  readOptions?.signal?.throwIfAborted();
  const documentIndex = chunkIds.indexOf(DOCUMENT_CHUNK_ID);
  return {
    id, rootId: indexed.rootId, revision: locator.revision,
    // Editing a document can precede an explicit legacy metadata upgrade.
    // Preparing a runtime consumer always evaluates this versioned contract.
    get requiredDependencies() { return registry.requiredDependenciesFor(id, indexed.header); },
    indexed, chunkIds,
    sourceBytes: lengths.reduce((sum, length) => sum + length, 0),
    documentBytes: documentIndex === -1
      ? new TextEncoder().encode(JSON.stringify(indexed.header.payload)).byteLength
      : lengths[documentIndex],
  };
}

function representationForRecord(
  registry: AssetRegistry,
  record: RegistryRecord,
  options: Omit<RegistryAssetLoadingOptions, "projectId" | "budgets">,
): AssetRepresentation<RegistryLoadedAsset> {
  const settingsKey = typeof options.representationKey === "function"
    ? options.representationKey(record.indexed) : options.representationKey ?? "document";
  // JSON decoding includes temporary UTF-16 text and an estimated object graph.
  // These CPU figures are estimates, distinct from exact source byte lengths.
  const decodedBytes = record.documentBytes * 8;
  return {
    key: JSON.stringify([settingsKey, record.chunkIds]),
    estimate: { sourceBytes: record.sourceBytes, decodedBytes, temporaryBytes: record.sourceBytes + record.documentBytes * 2 },
    load: async (asset, signal) => {
      if (asset.revision !== record.revision || asset.rootId !== record.rootId) {
        throw new SourceRevisionChangedError(`Asset ${record.id} changed after estimating its source bytes`);
      }
      const chunks = new Map<string, Uint8Array>();
      for (const chunkId of record.chunkIds) {
        signal.throwIfAborted();
        chunks.set(chunkId, await registry.readChunk(record.id, chunkId, record.revision, { signal }));
      }
      signal.throwIfAborted();
      if ((await registry.getAssetLocator(record.id, { signal })).revision !== record.revision) {
        throw new SourceRevisionChangedError(`Asset ${record.id} changed during reading; retry the current revision`);
      }
      const header = record.indexed.header;
      const documentBytes = chunks.get(DOCUMENT_CHUNK_ID);
      const payload = documentBytes
        ? JSON.parse(new TextDecoder().decode(documentBytes)) as Record<string, unknown>
        : structuredClone(header.payload);
      const value: RegistryLoadedAsset = {
        revision: record.revision,
        document: { type: header.type, name: header.name, guid: header.guid, version: header.version, payload },
        chunks,
      };
      return {
        value,
        sourceBytes: [...chunks.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
        decodedBytes,
        dispose: () => {
          try { options.onDispose?.(record.indexed, value); }
          finally { chunks.clear(); }
        },
      };
    },
  };
}
