import type { ProjectStorage } from "@babylonslate/core";
import { decodeAssetDocument } from "./asset-document";
import type { BlobStore } from "./blob-store";
import type { AssetRegistry, IndexedAsset } from "./registry";

export const DEFAULT_SEARCH_LIMIT = 80;
const MAX_INDEXED_STRING = 200;
const SKIP_PAYLOAD_KEYS = new Set(["body", "code", "source", "__pins"]);
const DOCUMENT_TYPES = new Set(["Scene", "Graph", "Class"]);
const VARIABLE_NODE_TYPES = new Set([
  "variables.get",
  "variables.set",
  "variables.getValidated",
]);

export type SearchEntryKind =
  | "asset"
  | "actor"
  | "component"
  | "graph-node"
  | "class"
  | "variable";

export type SearchOpenTarget =
  | { kind: "asset"; path: string; guid: string; assetType: string }
  | { kind: "scene-actor"; scenePath: string; actorId: string }
  | {
      kind: "scene-component";
      scenePath: string;
      actorId: string;
      componentId: string;
    }
  | { kind: "graph-node"; graphPath: string; nodeId: string }
  | { kind: "class"; classId: string; path?: string; guid?: string }
  | { kind: "variable"; name: string; graphPath: string; nodeId: string };

export interface SearchEntry {
  id: string;
  kind: SearchEntryKind;
  label: string;
  description?: string;
  keywords: string[];
  target: SearchOpenTarget;
  sourceGuid?: string;
  sourcePath?: string;
}

export interface ProjectSearchIndexOptions {
  blobs?: BlobStore;
  catalogClassIds?: readonly string[];
  nodeTitles?: Readonly<Record<string, string>>;
  limit?: number;
}

export interface ProjectSearchOpenDocument {
  path: string;
  payload: Record<string, unknown>;
}

export interface ProjectSearchRebuildOptions {
  signal?: AbortSignal;
  openDocuments?: readonly ProjectSearchOpenDocument[];
}

/**
 * Project-wide text index layered on the header-only asset registry.
 * May decode Scene/Graph document JSON; never loads binary payloads.
 */
export class ProjectSearchIndex {
  private readonly storage: ProjectStorage;
  private readonly blobs: BlobStore | undefined;
  private readonly catalogClassIds: readonly string[];
  private readonly nodeTitles: Readonly<Record<string, string>>;
  private readonly limit: number;
  private records: SearchRecord[] = [];
  private rebuildRevision = 0;

  constructor(storage: ProjectStorage, options: ProjectSearchIndexOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs;
    this.catalogClassIds = options.catalogClassIds ?? [];
    this.nodeTitles = options.nodeTitles ?? {};
    this.limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  }

  get size(): number {
    return this.records.length;
  }

  clear(): void {
    this.rebuildRevision += 1;
    this.records = [];
  }

  async rebuild(
    registry: AssetRegistry,
    options: ProjectSearchRebuildOptions = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    const revision = ++this.rebuildRevision;
    const snapshot = new ProjectSearchIndex(this.storage, {
      blobs: this.blobs,
      catalogClassIds: this.catalogClassIds,
      nodeTitles: this.nodeTitles,
      limit: this.limit,
    });
    const checkCurrent = () => {
      throwIfAborted(options.signal);
      if (revision !== this.rebuildRevision) {
        throw new DOMException("Search rebuild superseded", "AbortError");
      }
    };
    const overlays = new Map(
      (options.openDocuments ?? []).map((document) => [
        document.path,
        document.payload,
      ]),
    );
    await yieldSearchSlice();
    checkCurrent();
    let sliceStarted = performance.now();
    for (const asset of registry.list()) {
      checkCurrent();
      const overlay = overlays.get(asset.path);
      if (overlay) {
        snapshot.addHeaderEntries(asset);
        snapshot.addDocumentEntries(asset, overlay);
      } else {
        // Registry entries are unique; a fresh snapshot needs no repeated removal scan.
        await snapshot.indexAsset(asset, registry, false);
      }
      checkCurrent();
      if (performance.now() - sliceStarted >= 8) {
        await yieldSearchSlice();
        checkCurrent();
        sliceStarted = performance.now();
      }
    }
    snapshot.addCatalogClasses();
    checkCurrent();
    this.records = snapshot.records;
  }

  async upsertAsset(registry: AssetRegistry, path: string): Promise<void> {
    const asset = registry.getByPath(path) ?? registry.getByGuid(path);
    if (!asset) {
      this.removeAsset(path);
      return;
    }
    await this.indexAsset(asset, registry);
  }

  upsertDocument(asset: IndexedAsset, payload: Record<string, unknown>): void {
    this.removeBySource(asset.header.guid, asset.path);
    this.addHeaderEntries(asset);
    this.addDocumentEntries(asset, payload);
  }

  removeAsset(pathOrGuid: string): void {
    this.removeBySource(pathOrGuid, pathOrGuid);
  }

  /**
   * Case-insensitive substring query. Hits rank by match tier (exact label,
   * label prefix, label, description, keyword), then label collation, then
   * index order; the first `limit` are selected without sorting every hit.
   */
  query(needle: string, limit = this.limit): SearchEntry[] {
    const normalized = needle.trim().toLowerCase();
    if (!normalized) return [];

    const tiers: SearchEntry[][] = Array.from({ length: MATCH_TIERS }, () => []);
    for (const record of this.records) {
      const tier = matchTier(record, normalized);
      if (tier !== null) tiers[tier]!.push(record.entry);
    }
    const count = limit > 0 ? Math.floor(limit) : 0;
    const hits: SearchEntry[] = [];
    for (const tier of tiers) {
      const room = count - hits.length;
      if (room <= 0) break;
      for (const entry of firstByLabel(tier, room)) hits.push(entry);
    }
    return hits;
  }

  private add(entry: SearchEntry): void {
    this.records.push(searchRecord(entry));
  }

  private async indexAsset(
    asset: IndexedAsset,
    registry?: AssetRegistry,
    replaceExisting = true,
  ): Promise<void> {
    if (replaceExisting) this.removeBySource(asset.header.guid, asset.path);
    this.addHeaderEntries(asset);
    if (asset.placeholder || asset.header.type === "Unresolved") return;
    if (!DOCUMENT_TYPES.has(asset.header.type)) return;
    try {
      const storage = registry?.storageFor(asset.rootId) ?? this.storage;
      const blobs = registry?.blobsFor(asset.rootId) ?? this.blobs;
      const bytes = await storage.readBinary(asset.path);
      const document = await decodeAssetDocument(bytes, { blobs });
      this.addDocumentEntries(asset, document.payload);
    } catch {
      // Header-only fallback when the document chunk is missing or corrupt.
    }
  }

  private addHeaderEntries(asset: IndexedAsset): void {
    const { header, path } = asset;
    this.add({
      id: `asset:${header.guid}`,
      kind: "asset",
      label: header.name,
      description: `${header.type} · ${path}`,
      keywords: [
        header.type,
        path,
        header.guid,
        header.parentClass ?? "",
      ],
      target: {
        kind: "asset",
        path,
        guid: header.guid,
        assetType: header.type,
      },
      sourceGuid: header.guid,
      sourcePath: path,
    });

    if (header.type !== "Class") return;
    this.add({
      id: `class:${header.name}`,
      kind: "class",
      label: header.name,
      description: header.parentClass
        ? `extends ${header.parentClass}`
        : "Class",
      keywords: [header.parentClass ?? "", path, header.guid],
      target: {
        kind: "class",
        classId: header.name,
        path,
        guid: header.guid,
      },
      sourceGuid: header.guid,
      sourcePath: path,
    });
  }

  private addDocumentEntries(
    asset: IndexedAsset,
    payload: Record<string, unknown>,
  ): void {
    if (asset.header.type === "Scene") {
      this.addSceneEntries(asset, payload);
      return;
    }
    if (asset.header.type === "Graph" || asset.header.type === "Class") {
      this.addGraphEntries(asset, payload);
    }
  }

  private addSceneEntries(
    asset: IndexedAsset,
    payload: Record<string, unknown>,
  ): void {
    const actors = Array.isArray(payload.actors) ? payload.actors : [];
    for (const raw of actors) {
      if (!raw || typeof raw !== "object") continue;
      const actor = raw as Record<string, unknown>;
      const actorId = stringField(actor.id);
      if (!actorId) continue;
      const name = stringField(actor.name) || actorId;
      const classId = stringField(actor.classId);
      this.add({
        id: `actor:${asset.header.guid}:${actorId}`,
        kind: "actor",
        label: name,
        description: `${classId || "Actor"} · ${asset.path}`,
        keywords: [actorId, classId, asset.path, asset.header.name],
        target: {
          kind: "scene-actor",
          scenePath: asset.path,
          actorId,
        },
        sourceGuid: asset.header.guid,
        sourcePath: asset.path,
      });

      const components = Array.isArray(actor.components) ? actor.components : [];
      for (const rawComponent of components) {
        if (!rawComponent || typeof rawComponent !== "object") continue;
        const component = rawComponent as Record<string, unknown>;
        const componentId = stringField(component.id);
        if (!componentId) continue;
        const componentClass = stringField(component.classId);
        const propertyStrings = collectStringLeaves(component.properties);
        this.add({
          id: `component:${asset.header.guid}:${actorId}:${componentId}`,
          kind: "component",
          label: componentClass || componentId,
          description: `${name} · ${asset.path}`,
          keywords: [componentId, actorId, name, ...propertyStrings],
          target: {
            kind: "scene-component",
            scenePath: asset.path,
            actorId,
            componentId,
          },
          sourceGuid: asset.header.guid,
          sourcePath: asset.path,
        });
      }
    }
  }

  private addGraphEntries(
    asset: IndexedAsset,
    payload: Record<string, unknown>,
  ): void {
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      const nodeId = stringField(node.id);
      if (!nodeId) continue;
      const typeId = stringField(node.type);
      const data =
        node.data && typeof node.data === "object"
          ? (node.data as Record<string, unknown>)
          : {};
      const propertyStrings = collectStringLeaves(data);
      const title = this.nodeTitles[typeId] ?? typeId;
      this.add({
        id: `graph-node:${asset.header.guid}:${nodeId}`,
        kind: "graph-node",
        label: title || nodeId,
        description: `${typeId} · ${asset.path}`,
        keywords: [nodeId, typeId, asset.path, ...propertyStrings],
        target: {
          kind: "graph-node",
          graphPath: asset.path,
          nodeId,
        },
        sourceGuid: asset.header.guid,
        sourcePath: asset.path,
      });

      if (!VARIABLE_NODE_TYPES.has(typeId)) continue;
      const variableName =
        stringField(data.variableName) || stringField(data.name);
      if (!variableName) continue;
      this.add({
        id: `variable:${asset.header.guid}:${nodeId}:${variableName}`,
        kind: "variable",
        label: variableName,
        description: `${title} · ${asset.path}`,
        keywords: [typeId, nodeId, asset.path],
        target: {
          kind: "variable",
          name: variableName,
          graphPath: asset.path,
          nodeId,
        },
        sourceGuid: asset.header.guid,
        sourcePath: asset.path,
      });
    }
  }

  private addCatalogClasses(): void {
    const existing = new Set(
      this.records
        .filter(({ entry }) => entry.kind === "class")
        .map(({ entry }) =>
          entry.target.kind === "class" ? entry.target.classId : "",
        ),
    );
    for (const classId of this.catalogClassIds) {
      if (!classId || existing.has(classId)) continue;
      this.add({
        id: `class:${classId}`,
        kind: "class",
        label: classId,
        description: "Engine class",
        keywords: ["engine"],
        target: { kind: "class", classId },
      });
      existing.add(classId);
    }
  }

  private removeBySource(guid: string, path: string): void {
    this.records = this.records.filter(
      ({ entry }) => entry.sourceGuid !== guid && entry.sourcePath !== path,
    );
  }
}

function yieldSearchSlice(): Promise<void> {
  // Yield a task, not one display frame per asset; also works in hidden windows.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= MAX_INDEXED_STRING) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (SKIP_PAYLOAD_KEYS.has(key) || key.startsWith("__")) continue;
      collectStringLeaves(nested, out);
    }
  }
  return out;
}

/** An entry with the lowercased text a query matches, built once when indexed. */
interface SearchRecord {
  entry: SearchEntry;
  label: string;
  description: string;
  keywords: string[];
}

function searchRecord(entry: SearchEntry): SearchRecord {
  return {
    entry,
    label: entry.label.toLowerCase(),
    description: (entry.description ?? "").toLowerCase(),
    keywords: entry.keywords.map((keyword) => keyword.toLowerCase()),
  };
}

const MATCH_TIERS = 5;

function matchTier(record: SearchRecord, needle: string): number | null {
  if (record.label === needle) return 0;
  if (record.label.startsWith(needle)) return 1;
  if (record.label.includes(needle)) return 2;
  if (record.description.includes(needle)) return 3;
  if (record.keywords.some((keyword) => keyword.includes(needle))) return 4;
  return null;
}

/** Same order as `label.localeCompare(other)`. */
const LABEL_COLLATOR = new Intl.Collator();

function compareLabels(left: SearchEntry, right: SearchEntry): number {
  return LABEL_COLLATOR.compare(left.label, right.label);
}

/**
 * The first `count` entries of `entries` stably sorted by label: equal labels
 * keep their index order. A tier that fits is sorted; a larger one keeps a
 * bounded sorted buffer instead of sorting every hit.
 */
function firstByLabel(entries: SearchEntry[], count: number): SearchEntry[] {
  if (entries.length <= count) return entries.sort(compareLabels);
  const top: SearchEntry[] = [];
  for (const entry of entries) {
    if (top.length === count && compareLabels(entry, top[count - 1]!) >= 0) {
      continue;
    }
    // Insert after equal labels so earlier entries stay first.
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareLabels(entry, top[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    top.splice(low, 0, entry);
    if (top.length > count) top.pop();
  }
  return top;
}
