import { DOCUMENT_CHUNK_ID } from "./asset-document";
import { diffGraphDocuments, isGraphDocument, type GraphDiff } from "./asset-diff-graph";
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

/**
 * Where one version of an asset comes from: the working copy, or a commit
 * (`key` names it, so its decode is cached). Reads happen only for what the
 * diff needs: the `.hasset` once, and a blob only for a chunk it decodes.
 */
export interface AssetVersionSource {
  /** `path@commit` for a version that never changes; null for the working copy. */
  key: string | null;
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

/** A Texture's raster (its `source` or `pixels` chunk) for the preview. */
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

/** One decoded version: its header, with chunks decoded (and checked) only when asked, once. */
export class AssetVersion {
  readonly header: HassetHeader | null;
  readonly byteLength: number;
  private readonly bytes: Uint8Array | null;
  private readonly source: AssetVersionSource;
  private readonly decoded = new Map<string, Promise<Uint8Array | null>>();
  private documentValue: Promise<Record<string, unknown> | null> | null = null;

  private constructor(source: AssetVersionSource, bytes: Uint8Array | null) {
    this.source = source;
    this.bytes = bytes;
    this.byteLength = bytes?.byteLength ?? 0;
    this.header = bytes ? readHassetHeader(bytes) : null;
  }

  static async open(source: AssetVersionSource): Promise<AssetVersion> {
    return new AssetVersion(source, await source.read());
  }

  entry(id: string): ChunkEntry | undefined {
    return this.header?.chunks.find((chunk) => chunk.id === id);
  }

  /** A chunk's bytes, checked against its digest; read and decoded once. */
  chunk(id: string): Promise<Uint8Array | null> {
    let pending = this.decoded.get(id);
    if (!pending) {
      const entry = this.entry(id);
      pending = !this.bytes || !entry
        ? Promise.resolve(null)
        : decodeHassetChunk(this.bytes, id, (sha) => this.source.readBlob(sha, entry.byteLength));
      this.decoded.set(id, pending);
      // A failed read may succeed later (a download): do not keep the failure.
      pending.catch(() => this.decoded.delete(id));
    }
    return pending;
  }

  /** The editor document: the `document` chunk's JSON, or the header payload of a header-only asset. */
  document(): Promise<Record<string, unknown> | null> {
    if (!this.documentValue) {
      this.documentValue = (async () => {
        if (!this.header) return null;
        if (!this.entry(DOCUMENT_CHUNK_ID)) return this.header.payload;
        const bytes = await this.chunk(DOCUMENT_CHUNK_ID);
        const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        return isPlainObject(value) ? value : null;
      })();
      this.documentValue.catch(() => {
        this.documentValue = null;
      });
    }
    return this.documentValue;
  }
}

/** Decoded versions that never change (a commit's), by `path@commit`; the least recently used goes first. */
export class AssetVersionCache {
  private readonly entries = new Map<string, Promise<AssetVersion>>();
  private readonly capacity: number;

  constructor(capacity = 8) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.size;
  }

  open(source: AssetVersionSource): Promise<AssetVersion> {
    if (source.key === null) return AssetVersion.open(source);
    const known = this.entries.get(source.key);
    if (known) {
      this.entries.delete(source.key);
      this.entries.set(source.key, known);
      return known;
    }
    const opened = AssetVersion.open(source);
    this.entries.set(source.key, opened);
    opened.catch(() => {
      if (this.entries.get(source.key!) === opened) this.entries.delete(source.key!);
    });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return opened;
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
async function documents(base: AssetVersion, compare: AssetVersion): Promise<[Record<string, unknown> | null, Record<string, unknown> | null]> {
  const before = base.entry(DOCUMENT_CHUNK_ID);
  const after = compare.entry(DOCUMENT_CHUNK_ID);
  if (before && after && before.sha256 === after.sha256) {
    const shared = await base.document();
    return [shared, shared];
  }
  return [await base.document(), await compare.document()];
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
async function textureDiff(base: AssetVersion, compare: AssetVersion): Promise<TextureDiff> {
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
  const raster = async (version: AssetVersion, entry: ChunkEntry | undefined): Promise<TextureRaster | null> => {
    const bytes = entry ? await version.chunk(entry.id) : null;
    return bytes && entry ? { bytes, mime: entry.mime } : null;
  };
  const baseImage = await raster(base, baseRaster);
  const compareImage = baseRaster && compareRaster && baseRaster.sha256 === compareRaster.sha256 ? baseImage : await raster(compare, compareRaster);
  return { kind: "texture", rows, base: baseImage, compare: compareImage };
}

async function propertiesDiff(base: Record<string, unknown> | null, compare: Record<string, unknown> | null, title: string): Promise<PropertiesDiff> {
  return { kind: "properties", groups: documentGroups(base ?? undefined, compare ?? undefined, title) };
}

/** The document's view: Scenes by actor, graphs by node, Textures by raster, anything else by field. */
async function viewFor(type: string, base: AssetVersion, compare: AssetVersion): Promise<AssetDiffView> {
  if (type === "Texture") return textureDiff(base, compare);
  const [before, after] = await documents(base, compare);
  if (SCENE_TYPES.has(type)) return diffSceneDocuments(before, after);
  if (isGraphDocument(before) || isGraphDocument(after)) return diffGraphDocuments(before, after);
  return propertiesDiff(before, after, type);
}

/**
 * Two versions of one asset, decoded only as far as the diff needs: the
 * headers always, a chunk only when its view needs it, and a chunk the two
 * versions share (same digest) once. A version that is not a readable
 * `.hasset` rejects.
 */
export async function diffAssetVersions(path: string, base: AssetVersionSource, compare: AssetVersionSource, cache: AssetVersionCache): Promise<AssetDiff> {
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
    view: await viewFor(type, before, after),
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
