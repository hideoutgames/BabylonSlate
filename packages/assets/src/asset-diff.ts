import { DOCUMENT_CHUNK_ID } from "./document-chunk";
import type { GraphDiff } from "./asset-diff-graph";
import { diffGraphDocuments, isGraphDocument } from "./asset-diff-graph-families";
import { diffSceneDocuments, type SceneDiff } from "./asset-diff-scene";
import {
  documentGroups,
  formatBytes,
  groupStatus,
  isPlainObject,
  propertyRows,
  sameValue,
  valueRow,
  type DiffStatus,
  type PropertyDiffGroup,
  type PropertyDiffRow,
} from "./asset-diff-values";
import { decodeHassetChunk, readHassetHeader, type ChunkEntry, type HassetHeader } from "./hasset";

export * from "./asset-diff-values";
export * from "./asset-diff-scene";
export * from "./asset-diff-graph";
export * from "./asset-diff-graph-families";

/**
 * Where one version of an asset comes from: the working copy, or a commit
 * (`key` names it, so its decode is cached). Reads happen only for what the
 * diff needs: the `.hasset` once, and a blob only for a chunk it decodes.
 */
export interface AssetVersionSource {
  /** `path@commit` for a version that never changes; null for the working copy. */
  key: string | null;
  /**
   * Its reads return buffers nobody else holds (a file just read from
   * storage), so they move to the worker without a copy. Leave it unset when
   * the bytes may be kept elsewhere (a Git object cache).
   */
  owned?: boolean;
  /** The `.hasset` bytes, or null when this version has no such asset. */
  read(): Promise<Uint8Array | null>;
  /** A blob chunk's bytes (the `.blobs/<sha256>` object), as its chunk entry names it. */
  readBlob(sha256: string, byteLength: number): Promise<Uint8Array>;
}

/** One chunk of the container, as both versions list it. */
export interface ChunkDiff {
  id: string;
  kind: string;
  status: DiffStatus;
  base: { byteLength: number; sha256: string } | null;
  compare: { byteLength: number; sha256: string } | null;
}

/** A Texture's raster (its `source` or `pixels` chunk) for the preview; its bytes are its own buffer, which the worker hands over. */
export interface TextureRaster {
  bytes: Uint8Array;
  mime: string;
}

export interface TextureDiff {
  kind: "texture";
  rows: PropertyDiffRow[];
  base: TextureRaster | null;
  compare: TextureRaster | null;
}

/** Any other asset: its document's fields as property groups. */
export interface PropertiesDiff {
  kind: "properties";
  groups: PropertyDiffGroup[];
}

export type AssetDiffView = SceneDiff | GraphDiff | TextureDiff | PropertiesDiff;

export interface AssetDiff {
  path: string;
  /** The asset itself: added (no base), removed (no compare), changed or unchanged. */
  status: DiffStatus;
  type: string;
  name: string;
  /** Header fields first: name, type, parent class and the header payload. */
  header: PropertyDiffRow[];
  /** Every chunk either version lists; unchanged ones were never decoded for the diff. */
  chunks: ChunkDiff[];
  view: AssetDiffView;
}

const SCENE_TYPES = new Set(["Scene", "SceneLayer"]);
const RASTER_CHUNK_IDS = ["pixels", "source"];

/**
 * `work` once per key while it succeeds: a caller that finds it running
 * shares it, and one that finds it failed (the diff that started it was
 * cancelled, or its read failed) runs it again with its own reads.
 */
async function memo<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const running = cache.get(key);
  if (running) {
    try {
      return await running;
    } catch {
      // Started by another diff; this one reads for itself.
    }
  }
  const started = work();
  cache.set(key, started);
  started.catch(() => {
    if (cache.get(key) === started) cache.delete(key);
  });
  return started;
}

/**
 * One decoded version: its header, and its document parsed once when asked.
 * Other chunks (a Texture's raster) are read for each diff and kept by none:
 * they are the largest, and the reply hands them over. A cached version
 * serves many diffs, so every read goes through the source of the diff
 * asking: never through the one that opened it.
 */
export class AssetVersion {
  readonly header: HassetHeader | null;
  readonly byteLength: number;
  private readonly bytes: Uint8Array | null;
  private readonly documents = new Map<string, Promise<Record<string, unknown> | null>>();
  /** The parsed document's share of `retainedBytes`: its chunk's length. */
  private documentBytes = 0;

  private constructor(bytes: Uint8Array | null) {
    this.bytes = bytes;
    this.byteLength = bytes?.byteLength ?? 0;
    this.header = bytes ? readHassetHeader(bytes) : null;
  }

  static async open(source: AssetVersionSource): Promise<AssetVersion> {
    return new AssetVersion(await source.read());
  }

  /** What a cache keeps of it: the `.hasset`, and the parsed document counted at its chunk's length. */
  get retainedBytes(): number {
    return this.byteLength + this.documentBytes;
  }

  entry(id: string): ChunkEntry | undefined {
    return this.header?.chunks.find((chunk) => chunk.id === id);
  }

  /**
   * A chunk's bytes for one diff, checked against its digest and kept by
   * nothing: a blob's bytes as `source` read them, an inline chunk copied out
   * of the `.hasset`, so the caller owns the buffer.
   */
  async chunk(id: string, source: AssetVersionSource): Promise<Uint8Array | null> {
    const entry = this.entry(id);
    const bytes = this.bytes;
    if (!bytes || !entry) return null;
    const data = await decodeHassetChunk(bytes, id, (sha) => source.readBlob(sha, entry.byteLength));
    return data && "inline" in entry.locator ? data.slice() : data;
  }

  /** The editor document: the `document` chunk's JSON, or the header payload of a header-only asset. */
  document(source: AssetVersionSource): Promise<Record<string, unknown> | null> {
    return memo(this.documents, DOCUMENT_CHUNK_ID, async () => {
      const entry = this.entry(DOCUMENT_CHUNK_ID);
      if (!this.header || !this.bytes) return null;
      if (!entry) return this.header.payload;
      const bytes = await decodeHassetChunk(this.bytes, DOCUMENT_CHUNK_ID, (sha) => source.readBlob(sha, entry.byteLength));
      const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
      this.documentBytes = entry.byteLength;
      return isPlainObject(value) ? value : null;
    });
  }
}

/** A version as one diff reads it: the (possibly cached) decode, with that diff's own reads. */
interface Side {
  version: AssetVersion;
  source: AssetVersionSource;
}

/**
 * What the diff worker keeps of decoded commit versions. It needs the base
 * (and often the remote side) of the open diff while saves reload the working
 * side, plus the last few versions History browsed: a few large Scenes'
 * documents. Rasters are never kept, so no single version comes near it; it
 * shares the device's memory with the editor, hence no more.
 */
export const DIFF_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Decoded versions that never change (a commit's), by `path@commit`, within a
 * byte budget (`AssetVersion.retainedBytes`): after each diff (`trim`), the
 * least recently used go until the rest fit, so one larger than the whole
 * budget serves its diff and is not kept.
 */
export class AssetVersionCache {
  private readonly entries = new Map<string, Promise<AssetVersion>>();
  /** The entries that have opened, with their sizes. */
  private readonly opened = new Map<string, AssetVersion>();
  private readonly budget: number;

  constructor(budget = DIFF_CACHE_BYTES) {
    this.budget = budget;
  }

  /** What the kept versions hold now. */
  get bytes(): number {
    let total = 0;
    for (const key of this.entries.keys()) total += this.opened.get(key)?.retainedBytes ?? 0;
    return total;
  }

  async open(source: AssetVersionSource): Promise<AssetVersion> {
    const key = source.key;
    if (key === null) return AssetVersion.open(source);
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.entries.set(key, known);
    }
    const version = await memo(this.entries, key, () => AssetVersion.open(source));
    // Kept unless `trim` dropped it meanwhile.
    if (this.entries.has(key) && !this.opened.has(key)) this.opened.set(key, version);
    return version;
  }

  /** Drops the least recently used versions until the kept ones fit the budget; one still opening stays. */
  trim(): void {
    let total = this.bytes;
    for (const key of [...this.entries.keys()]) {
      if (total <= this.budget) return;
      const version = this.opened.get(key);
      if (!version) continue;
      this.entries.delete(key);
      this.opened.delete(key);
      total -= version.retainedBytes;
    }
  }
}

function chunkDiffs(base: HassetHeader | null, compare: HassetHeader | null): ChunkDiff[] {
  const before = new Map((base?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  const after = new Map((compare?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  return [...new Set([...after.keys(), ...before.keys()])].map((id) => {
    const from = before.get(id);
    const to = after.get(id);
    const status: DiffStatus = !from ? "added" : !to ? "removed" : from.sha256 === to.sha256 ? "unchanged" : "changed";
    return {
      id,
      kind: (to ?? from)!.kind,
      status,
      base: from ? { byteLength: from.byteLength, sha256: from.sha256 } : null,
      compare: to ? { byteLength: to.byteLength, sha256: to.sha256 } : null,
    };
  });
}

/** Name, type and parent class, then the header payload when the document lives in its own chunk. */
function headerRows(base: AssetVersion, compare: AssetVersion): PropertyDiffRow[] {
  const before = base.header;
  const after = compare.header;
  const rows = [
    valueRow("name", "Name", before?.name, after?.name),
    valueRow("type", "Type", before?.type, after?.type),
  ];
  if (before?.parentClass || after?.parentClass) rows.push(valueRow("parentClass", "Parent Class", before?.parentClass ?? undefined, after?.parentClass ?? undefined));
  const payloadIsDocument = (version: AssetVersion) => version.header !== null && !version.entry(DOCUMENT_CHUNK_ID);
  if (!payloadIsDocument(base) && !payloadIsDocument(compare)) rows.push(...propertyRows(before?.payload, after?.payload, "payload."));
  return rows;
}

/** Both versions' documents; one decode when the chunk is the same on both sides. */
async function documents(base: Side, compare: Side): Promise<[Record<string, unknown> | null, Record<string, unknown> | null]> {
  const before = base.version.entry(DOCUMENT_CHUNK_ID);
  const after = compare.version.entry(DOCUMENT_CHUNK_ID);
  if (before && after && before.sha256 === after.sha256) {
    const shared = await base.version.document(base.source);
    return [shared, shared];
  }
  return [await base.version.document(base.source), await compare.version.document(compare.source)];
}

function shortDigest(sha256: string): string {
  return sha256.slice(0, 7);
}

function rasterEntry(version: AssetVersion): ChunkEntry | undefined {
  for (const id of RASTER_CHUNK_IDS) {
    const entry = version.header?.chunks.find((chunk) => chunk.id === id || chunk.kind === id);
    if (entry) return entry;
  }
  return undefined;
}

/** Everything the asset takes on disk: the `.hasset` and the blobs its chunks are stored in. */
function storedBytes(version: AssetVersion): number | undefined {
  if (!version.header) return undefined;
  return version.byteLength + version.header.chunks.reduce((sum, chunk) => sum + ("blob" in chunk.locator ? chunk.byteLength : 0), 0);
}

function compressionLabel(payload: Record<string, unknown>): string {
  const state = typeof payload.compressionState === "string" ? payload.compressionState : "none";
  const quality = typeof payload.compressionQuality === "number" ? ` · Quality ${payload.compressionQuality}` : "";
  return state === "none" ? "None" : `${state.charAt(0).toUpperCase()}${state.slice(1).replace(/_/g, " ")}${quality}`;
}

/** A Texture's facts side by side, and both rasters for the preview (one decode when the raster did not change). */
async function textureDiff(baseSide: Side, compareSide: Side): Promise<TextureDiff> {
  const base = baseSide.version;
  const compare = compareSide.version;
  const before = base.header?.payload;
  const after = compare.header?.payload;
  const size = (payload: Record<string, unknown> | undefined) =>
    payload && typeof payload.width === "number" && typeof payload.height === "number" ? `${payload.width} × ${payload.height}` : payload ? "Unknown" : undefined;
  const baseRaster = rasterEntry(base);
  const compareRaster = rasterEntry(compare);
  const rasterLabel = (entry: ChunkEntry | undefined, version: AssetVersion) =>
    version.header ? (entry ? `${entry.mime.replace(/^image\//, "").toUpperCase()} · ${formatBytes(entry.byteLength)} · ${shortDigest(entry.sha256)}` : "None") : undefined;
  const text = (key: string) => (payload: Record<string, unknown> | undefined) => (payload ? (payload[key] === undefined ? "None" : String(payload[key])) : undefined);
  const rows: PropertyDiffRow[] = [
    valueRow("size", "Size", size(before), size(after), String),
    valueRow("fileSize", "File Size", storedBytes(base), storedBytes(compare), (value) => formatBytes(value as number)),
    { ...valueRow("source", "Source", rasterLabel(baseRaster, base), rasterLabel(compareRaster, compare), String), changed: baseRaster?.sha256 !== compareRaster?.sha256 },
    valueRow("usage", "Usage", text("usage")(before), text("usage")(after), String),
    valueRow("compression", "Compression", before ? compressionLabel(before) : undefined, after ? compressionLabel(after) : undefined, String),
    valueRow("downsample", "Downsample", text("downsample")(before), text("downsample")(after), String),
  ];
  const raster = async (side: Side, entry: ChunkEntry | undefined): Promise<TextureRaster | null> => {
    const bytes = entry ? await side.version.chunk(entry.id, side.source) : null;
    return bytes && entry ? { bytes, mime: entry.mime } : null;
  };
  const baseImage = await raster(baseSide, baseRaster);
  const compareImage = baseRaster && compareRaster && baseRaster.sha256 === compareRaster.sha256 ? baseImage : await raster(compareSide, compareRaster);
  return { kind: "texture", rows, base: baseImage, compare: compareImage };
}

async function propertiesDiff(base: Record<string, unknown> | null, compare: Record<string, unknown> | null, title: string): Promise<PropertiesDiff> {
  return { kind: "properties", groups: documentGroups(base ?? undefined, compare ?? undefined, title) };
}

/** The document's view: Scenes by actor, graphs by node (each family's own way), Textures by raster, anything else by field. */
async function viewFor(type: string, base: Side, compare: Side): Promise<AssetDiffView> {
  if (type === "Texture") return textureDiff(base, compare);
  const [before, after] = await documents(base, compare);
  if (SCENE_TYPES.has(type)) return diffSceneDocuments(before, after);
  if (isGraphDocument(type, before) || isGraphDocument(type, after)) return diffGraphDocuments(before, after, type);
  return propertiesDiff(before, after, type);
}

/**
 * Two versions of one asset, decoded only as far as the diff needs: the
 * headers always, a chunk only when its view needs it, and a chunk the two
 * versions share (same digest) once. A version that is not a readable
 * `.hasset` rejects.
 */
export async function diffAssetVersions(path: string, base: AssetVersionSource, compare: AssetVersionSource, cache: AssetVersionCache): Promise<AssetDiff> {
  try {
    return await diffVersions(path, base, compare, cache);
  } finally {
    // The versions have decoded what this diff needed: only now is their size known.
    cache.trim();
  }
}

async function diffVersions(path: string, base: AssetVersionSource, compare: AssetVersionSource, cache: AssetVersionCache): Promise<AssetDiff> {
  const [before, after] = await Promise.all([cache.open(base), cache.open(compare)]);
  const shown = after.header ?? before.header;
  const status: DiffStatus = !before.header && !after.header ? "unchanged" : !before.header ? "added" : !after.header ? "removed" : "changed";
  const chunks = chunkDiffs(before.header, after.header);
  const header = headerRows(before, after);
  const same = status === "changed" && chunks.every((chunk) => chunk.status === "unchanged") && header.every((row) => !row.changed) && sameValue(before.header?.payload, after.header?.payload);
  const type = shown?.type ?? "";
  return {
    path,
    status: same ? "unchanged" : status,
    type,
    name: shown?.name ?? path.slice(path.lastIndexOf("/") + 1),
    header,
    chunks,
    view: await viewFor(type, { version: before, source: base }, { version: after, source: compare }),
  };
}

/** The header rows and chunks as one group, for views that list them with the document's own groups. */
export function assetSummaryGroup(diff: Pick<AssetDiff, "header" | "chunks">): PropertyDiffGroup {
  const rows = [
    ...diff.header,
    ...diff.chunks.map((chunk) => valueRow(
      `chunk:${chunk.id}`,
      `${chunk.id} Chunk`,
      chunk.base ? `${formatBytes(chunk.base.byteLength)} · ${shortDigest(chunk.base.sha256)}` : undefined,
      chunk.compare ? `${formatBytes(chunk.compare.byteLength)} · ${shortDigest(chunk.compare.sha256)}` : undefined,
      String,
    )),
  ];
  return { id: "asset", title: "Asset", status: groupStatus(rows), rows };
}
