import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
  type IndexedAsset,
  type TilesetPayload,
} from "@babylonslate/assets";

/**
 * Where a Tilemap's referenced Tileset payload comes from: the open tab's
 * content, or the registry entry of a closed Tileset. An edit replaces the
 * open content object and a save or reindex replaces the registry entry, so
 * the object identifies one version of the payload.
 */
export type TilesetPayloadSource =
  | { guid: string; kind: "open"; content: object }
  | { guid: string; kind: "saved"; asset: IndexedAsset }
  | { guid: string; kind: "missing" };

export type LoadTilesetDocument = (
  kind: "tileset",
  path: string,
) => Promise<unknown | null>;

const EMPTY_PAYLOADS: ReadonlyMap<string, TilesetPayload> = new Map();

/** Normalized payloads by source object, shared by every Tilemap document. */
const payloadCache = new WeakMap<object, Promise<TilesetPayload | null>>();

function sourceObject(source: TilesetPayloadSource): object | null {
  switch (source.kind) {
    case "open":
      return source.content;
    case "saved":
      return source.asset;
    case "missing":
      return null;
  }
}

export function resolveTilesetSources(
  guids: readonly string[],
  registry: { getByGuid(guid: string): IndexedAsset | undefined } | null | undefined,
  openDocuments: readonly { ref: { path: string }; content: unknown }[],
): TilesetPayloadSource[] {
  return guids.map((guid): TilesetPayloadSource => {
    const asset = registry?.getByGuid(guid);
    if (!asset) return { guid, kind: "missing" };
    const content = openDocuments.find((doc) => doc.ref.path === asset.path)?.content;
    if (content && typeof content === "object") return { guid, kind: "open", content };
    return { guid, kind: "saved", asset };
  });
}

/** True when both lists name the same Tilesets through the same source objects. */
export function sameTilesetSources(
  a: readonly TilesetPayloadSource[],
  b: readonly TilesetPayloadSource[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (source, index) =>
        source.guid === b[index]!.guid && sourceObject(source) === sourceObject(b[index]!),
    )
  );
}

function loadTilesetPayload(
  source: TilesetPayloadSource,
  loadDocument: LoadTilesetDocument,
): Promise<TilesetPayload | null> {
  const key = sourceObject(source);
  if (!key) return Promise.resolve(null);
  const cached = payloadCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const raw =
        source.kind === "saved"
          ? await loadDocument("tileset", source.asset.path)
          : key;
      return raw ? ensureTilesetTiles(normalizeTilesetPayload(raw)) : null;
    } catch {
      return null;
    }
  })();
  payloadCache.set(key, pending);
  void pending.then((payload) => {
    // An unreadable Tileset is tried again by a later request, not remembered.
    if (!payload && payloadCache.get(key) === pending) payloadCache.delete(key);
  });
  return pending;
}

/** Payloads by Tileset guid; unchanged sources reuse their cached payload without reading storage. */
export async function loadTilesetPayloads(
  sources: readonly TilesetPayloadSource[],
  loadDocument: LoadTilesetDocument,
): Promise<ReadonlyMap<string, TilesetPayload>> {
  const loaded = await Promise.all(
    sources.map((source) => loadTilesetPayload(source, loadDocument)),
  );
  const next = new Map<string, TilesetPayload>();
  sources.forEach((source, index) => {
    const payload = loaded[index];
    if (payload) next.set(source.guid, payload);
  });
  return next;
}

function samePayloads(
  a: ReadonlyMap<string, TilesetPayload>,
  b: ReadonlyMap<string, TilesetPayload>,
): boolean {
  if (a.size !== b.size) return false;
  const left = [...a];
  let index = 0;
  for (const [guid, payload] of b) {
    const [leftGuid, leftPayload] = left[index++]!;
    if (leftGuid !== guid || leftPayload !== payload) return false;
  }
  return true;
}

/**
 * One payload map for a Tilemap document's panels. Details, Palette and Paint
 * request the same sources; only the first request after a source changes
 * loads, and every panel reads the published map.
 */
export class TilesetPayloadLoader {
  private payloads = EMPTY_PAYLOADS;
  private requested: readonly TilesetPayloadSource[] | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadonlyMap<string, TilesetPayload> => this.payloads;

  request(
    sources: readonly TilesetPayloadSource[],
    loadDocument: LoadTilesetDocument,
  ): void {
    if (this.requested && sameTilesetSources(this.requested, sources)) return;
    this.requested = sources;
    const generation = ++this.generation;
    void loadTilesetPayloads(sources, loadDocument).then((next) => {
      if (generation !== this.generation || samePayloads(this.payloads, next)) return;
      this.payloads = next;
      for (const listener of [...this.listeners]) listener();
    });
  }
}
