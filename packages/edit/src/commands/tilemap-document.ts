import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

/**
 * Tilemap edits as deltas: an Undo step, a journal record and the history
 * budget hold only the chunks a change touched (plus any changed top-level
 * field or layer setting), never two copies of the whole map. The documents
 * are Tilemap payloads (`layers[].chunks[] { cx, cy, tiles }`); this package
 * reads that shape without depending on `@haptic/assets`.
 */

/** A layer's settings: the layer without its chunks. */
type LayerShell = Record<string, unknown> & { id: string };

/** One chunk's `tiles` before and after the change; `null` where the chunk is absent. */
export interface TilemapChunkPatch {
  layer: string;
  cx: number;
  cy: number;
  from: readonly number[] | null;
  to: readonly number[] | null;
}

/** A layer's chunk keys `[cx, cy]` in list order. */
type ChunkOrder = ReadonlyArray<readonly [number, number]>;

/**
 * What one Tilemap change replaced. Every part holds its value before (`from`)
 * and after (`to`), so applying writes `to`, inverting swaps the sides, and two
 * changes of one gesture fold into the earlier `from` and the later `to`.
 */
export interface TilemapDocumentDelta {
  /** Top-level fields other than `layers` that changed; a value missing from a side means the field is absent there. */
  fields?: { keys: readonly string[]; from: Readonly<Record<string, unknown>>; to: Readonly<Record<string, unknown>> };
  /** The layer list without chunks, when a layer was added, removed, reordered or had a setting changed. */
  layers?: { from: readonly LayerShell[]; to: readonly LayerShell[] };
  /** Per layer id, the chunk order when the layer's chunk keys or their order changed. */
  order?: Readonly<Record<string, { from: ChunkOrder; to: ChunkOrder }>>;
  chunks: readonly TilemapChunkPatch[];
}

type Doc = Record<string, unknown>;
type Layer = Record<string, unknown> & { id: string; chunks: readonly Chunk[] };
type Chunk = { cx: number; cy: number; tiles: readonly number[] };

/** Chunk keys stay exact for coordinates of up to a million chunks either way. */
function chunkKey(cx: number, cy: number): number {
  return (cy + 2 ** 20) * 2 ** 21 + (cx + 2 ** 20);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  // Top-level fields and layer settings are small (the Tileset list, sizes).
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameTiles(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

function shellOf(layer: Layer): LayerShell {
  const { chunks: _chunks, ...shell } = layer;
  void _chunks;
  return shell as LayerShell;
}

/** The layers of a document in the shape a delta reads, or `null` when it is not one (it is then replaced whole). */
function layersOf(doc: Doc): Layer[] | null {
  const layers = doc.layers ?? [];
  if (!Array.isArray(layers)) return null;
  const ids = new Set<string>();
  for (const layer of layers as unknown[]) {
    if (!layer || typeof layer !== "object") return null;
    const { id, chunks } = layer as { id?: unknown; chunks?: unknown };
    if (typeof id !== "string" || ids.has(id) || !Array.isArray(chunks)) return null;
    ids.add(id);
    const keys = new Set<number>();
    for (const chunk of chunks as unknown[]) {
      if (!chunk || typeof chunk !== "object") return null;
      const { cx, cy, tiles } = chunk as { cx?: unknown; cy?: unknown; tiles?: unknown };
      if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Array.isArray(tiles)) return null;
      const key = chunkKey(cx as number, cy as number);
      if (keys.has(key)) return null;
      keys.add(key);
    }
  }
  return layers as Layer[];
}

function orderOf(chunks: readonly Chunk[]): Array<[number, number]> {
  return chunks.map((chunk) => [chunk.cx, chunk.cy]);
}

function sameOrder(a: ChunkOrder, b: ChunkOrder): boolean {
  return a.length === b.length && a.every(([cx, cy], at) => b[at]![0] === cx && b[at]![1] === cy);
}

/**
 * The delta from `previous` to `next`, found by identity first: a layer, chunk
 * array or `tiles` array that is the same object is unchanged without being
 * read, and only chunks whose `tiles` are new arrays are compared cell by cell.
 * Payloads are never changed in place, so an edit built with `setTiles` costs
 * the chunks it touched. Returns `"unchanged"` when nothing differs, or
 * `"unsupported"` when either side is not a Tilemap of unique layer ids and
 * chunk keys (the change is then recorded whole).
 */
export function diffTilemapDocument(previous: Doc, next: Doc): TilemapDocumentDelta | "unchanged" | "unsupported" {
  if (previous === next) return "unchanged";
  const before = layersOf(previous);
  const after = layersOf(next);
  if (!before || !after) return "unsupported";
  const delta: { fields?: TilemapDocumentDelta["fields"]; layers?: TilemapDocumentDelta["layers"]; order?: Record<string, { from: ChunkOrder; to: ChunkOrder }>; chunks: TilemapChunkPatch[] } = { chunks: [] };

  const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter((key) => key !== "layers");
  const changed = keys.filter((key) => Object.hasOwn(previous, key) !== Object.hasOwn(next, key) || !sameValue(previous[key], next[key]));
  if (changed.length > 0) {
    const from: Doc = {};
    const to: Doc = {};
    for (const key of changed) {
      if (Object.hasOwn(previous, key)) from[key] = previous[key];
      if (Object.hasOwn(next, key)) to[key] = next[key];
    }
    delta.fields = { keys: changed, from, to };
  }

  if (before !== after) {
    const shellsChanged = before.length !== after.length ||
      before.some((layer, at) => layer !== after[at] && !sameValue(shellOf(layer), shellOf(after[at]!)));
    if (shellsChanged) delta.layers = { from: before.map(shellOf), to: after.map(shellOf) };
    const previousById = new Map(before.map((layer) => [layer.id, layer]));
    const nextIds = new Set(after.map((layer) => layer.id));
    const diffLayer = (id: string, from: readonly Chunk[], to: readonly Chunk[]) => {
      if (from === to) return;
      const fromByKey = new Map(from.map((chunk) => [chunkKey(chunk.cx, chunk.cy), chunk]));
      const toKeys = new Set<number>();
      for (const chunk of to) {
        const key = chunkKey(chunk.cx, chunk.cy);
        toKeys.add(key);
        const old = fromByKey.get(key);
        if (old === chunk || (old && sameTiles(old.tiles, chunk.tiles))) continue;
        delta.chunks.push({ layer: id, cx: chunk.cx, cy: chunk.cy, from: old?.tiles ?? null, to: chunk.tiles });
      }
      for (const chunk of from) {
        if (!toKeys.has(chunkKey(chunk.cx, chunk.cy))) delta.chunks.push({ layer: id, cx: chunk.cx, cy: chunk.cy, from: chunk.tiles, to: null });
      }
      const fromOrder = orderOf(from);
      const toOrder = orderOf(to);
      if (!sameOrder(fromOrder, toOrder)) (delta.order ??= {})[id] = { from: fromOrder, to: toOrder };
    };
    for (const layer of after) {
      const old = previousById.get(layer.id);
      if (old !== layer) diffLayer(layer.id, old?.chunks ?? [], layer.chunks);
    }
    for (const layer of before) if (!nextIds.has(layer.id)) diffLayer(layer.id, layer.chunks, []);
  }

  return delta.fields || delta.layers || delta.order || delta.chunks.length > 0 ? delta : "unchanged";
}

function invertDelta(delta: TilemapDocumentDelta): TilemapDocumentDelta {
  return {
    ...(delta.fields ? { fields: { keys: delta.fields.keys, from: delta.fields.to, to: delta.fields.from } } : {}),
    ...(delta.layers ? { layers: { from: delta.layers.to, to: delta.layers.from } } : {}),
    ...(delta.order
      ? { order: Object.fromEntries(Object.entries(delta.order).map(([id, order]) => [id, { from: order.to, to: order.from }])) }
      : {}),
    chunks: delta.chunks.map((patch) => ({ ...patch, from: patch.to, to: patch.from })),
  };
}

/** `first` then `second` as one delta: each part keeps `first`'s `from` and `second`'s `to`; parts that end where they began drop out. */
function composeDeltas(first: TilemapDocumentDelta, second: TilemapDocumentDelta): TilemapDocumentDelta {
  const composed: { fields?: TilemapDocumentDelta["fields"]; layers?: TilemapDocumentDelta["layers"]; order?: Record<string, { from: ChunkOrder; to: ChunkOrder }>; chunks: TilemapChunkPatch[] } = { chunks: [] };
  if (first.fields || second.fields) {
    const firstKeys = new Set(first.fields?.keys ?? []);
    const secondKeys = new Set(second.fields?.keys ?? []);
    const from: Doc = {};
    const to: Doc = {};
    const keys: string[] = [];
    for (const key of new Set([...firstKeys, ...secondKeys])) {
      const fromSide = firstKeys.has(key) ? first.fields!.from : second.fields!.from;
      const toSide = secondKeys.has(key) ? second.fields!.to : first.fields!.to;
      const hasFrom = Object.hasOwn(fromSide, key);
      const hasTo = Object.hasOwn(toSide, key);
      if (hasFrom === hasTo && (!hasFrom || sameValue(fromSide[key], toSide[key]))) continue;
      keys.push(key);
      if (hasFrom) from[key] = fromSide[key];
      if (hasTo) to[key] = toSide[key];
    }
    if (keys.length > 0) composed.fields = { keys, from, to };
  }
  const layersFrom = first.layers?.from ?? second.layers?.from;
  const layersTo = second.layers?.to ?? first.layers?.to;
  if (layersFrom && layersTo && !sameValue(layersFrom, layersTo)) composed.layers = { from: layersFrom, to: layersTo };
  for (const id of new Set([...Object.keys(first.order ?? {}), ...Object.keys(second.order ?? {})])) {
    const from = first.order?.[id]?.from ?? second.order![id]!.from;
    const to = second.order?.[id]?.to ?? first.order![id]!.to;
    if (!sameOrder(from, to)) (composed.order ??= {})[id] = { from, to };
  }
  const patches = new Map<string, TilemapChunkPatch>();
  const patchKey = (patch: TilemapChunkPatch) => `${patch.layer}\u0000${chunkKey(patch.cx, patch.cy)}`;
  for (const patch of first.chunks) patches.set(patchKey(patch), patch);
  for (const patch of second.chunks) {
    const earlier = patches.get(patchKey(patch));
    patches.set(patchKey(patch), earlier ? { ...patch, from: earlier.from } : patch);
  }
  for (const patch of patches.values()) {
    if (patch.from === patch.to || (patch.from && patch.to && sameTiles(patch.from, patch.to))) continue;
    composed.chunks.push(patch);
  }
  return composed;
}

/** Write a delta's `to` side onto `doc`; layers and chunks it does not name keep their objects. */
function applyDelta(doc: Doc, delta: TilemapDocumentDelta): Doc {
  const next: Doc = { ...doc };
  if (delta.fields) {
    for (const key of delta.fields.keys) {
      if (Object.hasOwn(delta.fields.to, key)) next[key] = delta.fields.to[key];
      else delete next[key];
    }
  }
  const layers = (Array.isArray(doc.layers) ? doc.layers : []) as Layer[];
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const patchesByLayer = new Map<string, TilemapChunkPatch[]>();
  for (const patch of delta.chunks) {
    const list = patchesByLayer.get(patch.layer);
    if (list) list.push(patch);
    else patchesByLayer.set(patch.layer, [patch]);
  }
  const shells: readonly LayerShell[] = delta.layers?.to ?? layers.map(shellOf);
  let same = shells.length === layers.length;
  const nextLayers = shells.map((shell, at) => {
    const previous = byId.get(shell.id);
    const patches = patchesByLayer.get(shell.id);
    const order = delta.order?.[shell.id]?.to;
    const settingsKept = previous !== undefined && (!delta.layers || sameValue(shellOf(previous), shell));
    if (previous && settingsKept && !patches && !order) {
      same &&= previous === layers[at];
      return previous;
    }
    same = false;
    const chunks = previous?.chunks ?? [];
    let nextChunks: readonly Chunk[] = chunks;
    if (patches || order) {
      const byKey = new Map(chunks.map((chunk) => [chunkKey(chunk.cx, chunk.cy), chunk]));
      const added: Chunk[] = [];
      for (const patch of patches ?? []) {
        const key = chunkKey(patch.cx, patch.cy);
        if (!patch.to) {
          byKey.delete(key);
          continue;
        }
        const old = byKey.get(key);
        const chunk = old ? { ...old, tiles: patch.to } : { cx: patch.cx, cy: patch.cy, tiles: patch.to };
        if (!old) added.push(chunk);
        byKey.set(key, chunk);
      }
      nextChunks = order
        ? order.flatMap(([cx, cy]) => byKey.get(chunkKey(cx, cy)) ?? [])
        : [...chunks.flatMap((chunk) => byKey.get(chunkKey(chunk.cx, chunk.cy)) ?? []), ...added];
    }
    return { ...(settingsKept && previous ? shellOf(previous) : shell), chunks: nextChunks };
  });
  next.layers = same ? doc.layers : nextLayers;
  return next;
}

/**
 * A Tilemap edit recorded as its delta (`diffTilemapDocument`). Applying it to
 * the document it was taken from gives the edited document, sharing every
 * layer, chunk and `tiles` array the edit did not touch; nothing is cloned,
 * since payloads are never changed in place. Its history cost is the delta's.
 */
export class PatchTilemapDocumentCommand implements EditCommand<Doc> {
  readonly type = "asset.patchTilemap";
  readonly delta: TilemapDocumentDelta;
  readonly mergeKey?: string;
  #bytes?: number;

  constructor(delta: TilemapDocumentDelta, mergeKey?: string) {
    this.delta = delta;
    if (mergeKey !== undefined) this.mergeKey = mergeKey;
  }

  /** The delta's serialized size, measured on first read: both sides of every part it holds. */
  get byteSize(): number {
    return (this.#bytes ??= snapshotBytes(this.delta));
  }

  apply(doc: Doc): Doc {
    return applyDelta(doc, this.delta);
  }

  invert(): PatchTilemapDocumentCommand {
    const inverse = new PatchTilemapDocumentCommand(invertDelta(this.delta));
    inverse.#bytes = this.#bytes;
    return inverse;
  }

  /** A gesture keeps one delta from its first state to its latest. */
  coalesce(next: EditCommand<Doc>): PatchTilemapDocumentCommand | undefined {
    if (!(next instanceof PatchTilemapDocumentCommand) || next.mergeKey !== this.mergeKey) return undefined;
    return new PatchTilemapDocumentCommand(composeDeltas(this.delta, next.delta), this.mergeKey);
  }
}

function isTiles(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isOrder(value: unknown): value is Array<[number, number]> {
  return Array.isArray(value) &&
    value.every((entry) => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && Number.isInteger(entry[1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Revives a journaled Tilemap delta; a malformed record throws, so replay skips it. */
export function createPatchTilemapDocumentCommandFromJson(payload: Record<string, unknown>): PatchTilemapDocumentCommand {
  const delta = payload.delta;
  if (!isRecord(delta) || !Array.isArray(delta.chunks)) throw new Error("asset.patchTilemap has no delta.");
  const chunks = delta.chunks.map((patch: unknown): TilemapChunkPatch => {
    if (!isRecord(patch) || typeof patch.layer !== "string" || !Number.isInteger(patch.cx) || !Number.isInteger(patch.cy) ||
      !(patch.from === null || isTiles(patch.from)) || !(patch.to === null || isTiles(patch.to))) {
      throw new Error("asset.patchTilemap has a malformed chunk.");
    }
    return { layer: patch.layer, cx: patch.cx as number, cy: patch.cy as number, from: patch.from, to: patch.to };
  });
  const result: { fields?: TilemapDocumentDelta["fields"]; layers?: TilemapDocumentDelta["layers"]; order?: Record<string, { from: ChunkOrder; to: ChunkOrder }>; chunks: TilemapChunkPatch[] } = { chunks };
  if (delta.fields !== undefined) {
    const fields = delta.fields;
    if (!isRecord(fields) || !Array.isArray(fields.keys) || !fields.keys.every((key) => typeof key === "string") ||
      !isRecord(fields.from) || !isRecord(fields.to)) throw new Error("asset.patchTilemap has malformed fields.");
    result.fields = { keys: fields.keys as string[], from: fields.from, to: fields.to };
  }
  if (delta.layers !== undefined) {
    const layers = delta.layers;
    const shells = (value: unknown) => Array.isArray(value) && value.every((shell) => isRecord(shell) && typeof shell.id === "string");
    if (!isRecord(layers) || !shells(layers.from) || !shells(layers.to)) throw new Error("asset.patchTilemap has malformed layers.");
    result.layers = { from: layers.from as LayerShell[], to: layers.to as LayerShell[] };
  }
  if (delta.order !== undefined) {
    if (!isRecord(delta.order)) throw new Error("asset.patchTilemap has a malformed order.");
    result.order = {};
    for (const [id, order] of Object.entries(delta.order)) {
      if (!isRecord(order) || !isOrder(order.from) || !isOrder(order.to)) throw new Error("asset.patchTilemap has a malformed order.");
      result.order[id] = { from: order.from, to: order.to };
    }
  }
  const mergeKey = typeof payload.mergeKey === "string" && payload.mergeKey.length > 0 ? payload.mergeKey : undefined;
  return new PatchTilemapDocumentCommand(result, mergeKey);
}
