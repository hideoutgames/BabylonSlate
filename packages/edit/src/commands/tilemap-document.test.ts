import { describe, expect, it } from "vitest";
import { commandToJournalPayload, serializeJournalLine } from "../journal";
import { replayJournalLines } from "../journal-replay";
import { snapshotBytes } from "../snapshot-bytes";
import { DocumentEditStack } from "../stack";
import { SetAssetDocumentCommand } from "./asset-document";
import { PatchTilemapDocumentCommand, diffTilemapDocument, type TilemapDocumentDelta } from "./tilemap-document";

type Chunk = { cx: number; cy: number; tiles: number[] };
type Layer = { id: string; name: string; visible: boolean; chunks: Chunk[] };
type TilemapFixture = { tilesets: Array<{ guid: string; firstGid: number; tileCount: number }>; width: number; height: number; chunkSize: number; layers: Layer[] };

const SIZE = 32;

function chunk(cx: number, cy: number, fill = 0, cells: Record<number, number> = {}): Chunk {
  const tiles = Array<number>(SIZE * SIZE).fill(fill);
  for (const [at, gid] of Object.entries(cells)) tiles[Number(at)] = gid;
  return { cx, cy, tiles };
}

/** A dense 256 × 256 map: two layers of 8 × 8 full chunks. */
function denseMap(): TilemapFixture {
  const chunks = (gid: number) => Array.from({ length: 64 }, (_, at) => chunk(at % 8, Math.floor(at / 8), gid));
  return {
    tilesets: [{ guid: "ground", firstGid: 1, tileCount: 64 }],
    width: 256,
    height: 256,
    chunkSize: SIZE,
    layers: [
      { id: "layer-1", name: "Ground", visible: true, chunks: chunks(1) },
      { id: "layer-2", name: "Props", visible: true, chunks: chunks(2) },
    ],
  };
}

/** `map` with one cell of one chunk changed, as `setTiles` builds it: only that chunk and its layer are new objects. */
function withCell(map: TilemapFixture, layerAt: number, chunkAt: number, cell: number, gid: number): TilemapFixture {
  const layers = [...map.layers];
  const layer = layers[layerAt]!;
  const chunks = [...layer.chunks];
  const tiles = [...chunks[chunkAt]!.tiles];
  tiles[cell] = gid;
  chunks[chunkAt] = { ...chunks[chunkAt]!, tiles };
  layers[layerAt] = { ...layer, chunks };
  return { ...map, layers };
}

const doc = (map: TilemapFixture) => map as unknown as Record<string, unknown>;

function patch(previous: TilemapFixture, next: TilemapFixture, mergeKey?: string): PatchTilemapDocumentCommand {
  const delta = diffTilemapDocument(doc(previous), doc(next));
  if (typeof delta === "string") throw new Error(`expected a delta, got ${delta}`);
  return new PatchTilemapDocumentCommand(delta, mergeKey);
}

describe("PatchTilemapDocumentCommand", () => {
  it("records only the touched chunk, and applies and reverts it sharing every untouched layer and chunk", () => {
    const map = denseMap();
    const painted = withCell(map, 0, 9, 5, 7);
    const command = patch(map, painted);
    expect(command.delta).toEqual({ chunks: [{ layer: "layer-1", cx: 1, cy: 1, from: map.layers[0]!.chunks[9]!.tiles, to: painted.layers[0]!.chunks[9]!.tiles }] });
    const applied = command.apply(doc(map)) as unknown as TilemapFixture;
    expect(JSON.stringify(applied)).toBe(JSON.stringify(painted));
    expect(applied.layers[1]).toBe(map.layers[1]);
    expect(applied.layers[0]!.chunks[8]).toBe(map.layers[0]!.chunks[8]);
    // Nothing is cloned: the edited chunk takes the edit's own cells.
    expect(applied.layers[0]!.chunks[9]!.tiles).toBe(painted.layers[0]!.chunks[9]!.tiles);
    const reverted = command.invert().apply(doc(applied)) as unknown as TilemapFixture;
    expect(JSON.stringify(reverted)).toBe(JSON.stringify(map));
    expect(reverted.layers[1]).toBe(map.layers[1]);
  });

  it("costs Undo history by the chunk a one-cell edit changed, not by the map", () => {
    const map = denseMap();
    const painted = withCell(map, 1, 63, 0, 9);
    const mapBytes = snapshotBytes(map);
    const command = patch(map, painted);
    // Both sides of one 32 × 32 chunk, plus the record's keys.
    expect(command.byteSize).toBeLessThan(2 * snapshotBytes(map.layers[1]!.chunks[63]!.tiles) + 200);
    expect(new SetAssetDocumentCommand(doc(map), doc(painted)).byteSize).toBeGreaterThan(2 * mapBytes - 100);
    // A budget that holds a few chunks but not a whole map keeps every one-cell stroke.
    const stack = new DocumentEditStack<Record<string, unknown>>({ maxEntries: 100, maxBytes: mapBytes });
    let current = map;
    for (let stroke = 0; stroke < 40; stroke++) {
      const next = withCell(current, stroke % 2, stroke, stroke, 30 + stroke);
      stack.apply(doc(current), patch(current, next, `tilemap-stroke:${stroke}`));
      current = next;
    }
    expect(stack.undoDepth).toBe(40);
    expect(stack.undoBytes).toBeLessThan(40 * 2 * 4_000);
    let undone = doc(current);
    while (stack.canUndo) undone = stack.undo(undone)!.doc;
    expect(JSON.stringify(undone)).toBe(JSON.stringify(map));
  });

  it("folds one gesture into a delta from its first state to its latest", () => {
    const map = denseMap();
    const stack = new DocumentEditStack<Record<string, unknown>>({ maxEntries: 10, maxBytes: 10_000_000 });
    const first = withCell(map, 0, 0, 0, 5);
    const second = withCell(first, 0, 1, 0, 6);
    // The last step puts the first chunk back, so only the second one is left changed.
    const third = { ...second, layers: [{ ...second.layers[0]!, chunks: [map.layers[0]!.chunks[0]!, ...second.layers[0]!.chunks.slice(1)] }, second.layers[1]!] };
    let current = doc(map);
    for (const [from, to] of [[map, first], [first, second], [second, third]] as const) {
      current = stack.apply(current, patch(from, to, "tilemap:scrub")).doc;
    }
    expect(stack.undoDepth).toBe(1);
    expect(stack.undoBytes).toBeLessThan(2 * snapshotBytes(map.layers[0]!.chunks[1]!.tiles) + 200);
    expect(JSON.stringify(current)).toBe(JSON.stringify(third));
    current = stack.undo(current)!.doc;
    expect(JSON.stringify(current)).toBe(JSON.stringify(map));
    current = stack.redo(current)!.doc;
    expect(JSON.stringify(current)).toBe(JSON.stringify(third));
  });

  it("adds and removes layers and chunks, reorders them and changes fields, in both directions", () => {
    const map: TilemapFixture = {
      tilesets: [{ guid: "ground", firstGid: 1, tileCount: 4 }],
      width: 64,
      height: 64,
      chunkSize: SIZE,
      layers: [
        { id: "layer-1", name: "Ground", visible: true, chunks: [chunk(0, 0, 0, { 0: 1 }), chunk(1, 0, 0, { 3: 2 })] },
        { id: "layer-2", name: "Props", visible: true, chunks: [chunk(0, 1, 0, { 9: 3 })] },
      ],
    };
    const edited: TilemapFixture = {
      ...map,
      tilesets: [{ guid: "ground", firstGid: 5, tileCount: 8 }],
      width: 32,
      layers: [
        // Reordered, with Props hidden and gaining a chunk at the front.
        { ...map.layers[1]!, visible: false, chunks: [chunk(2, 2, 0, { 1: 4 }), map.layers[1]!.chunks[0]!] },
        // Ground loses its first chunk.
        { ...map.layers[0]!, chunks: [map.layers[0]!.chunks[1]!] },
        { id: "layer-3", name: "Decals", visible: true, chunks: [chunk(0, 0, 0, { 5: 1 })] },
      ],
    };
    const command = patch(map, edited);
    expect(command.delta.fields?.keys).toEqual(["tilesets", "width"]);
    expect(command.delta.layers?.to.map((shell) => [shell.id, shell.visible])).toEqual([["layer-2", false], ["layer-1", true], ["layer-3", true]]);
    expect(JSON.stringify(command.apply(doc(map)))).toBe(JSON.stringify(edited));
    expect(JSON.stringify(command.invert().apply(doc(edited)))).toBe(JSON.stringify(map));
    // Removing every layer and field change also round-trips.
    const emptied = { ...map, layers: [] };
    const cleared = patch(map, emptied);
    expect(JSON.stringify(cleared.apply(doc(map)))).toBe(JSON.stringify(emptied));
    expect(JSON.stringify(cleared.invert().apply(doc(emptied)))).toBe(JSON.stringify(map));
  });

  it("records a switch to unbounded with a pivot and a negative chunk, and undoes it to the sized map", () => {
    const map: TilemapFixture = {
      tilesets: [{ guid: "ground", firstGid: 1, tileCount: 4 }],
      width: 64,
      height: 64,
      chunkSize: SIZE,
      layers: [{ id: "layer-1", name: "Ground", visible: true, chunks: [chunk(0, 0, 0, { 0: 1 })] }],
    };
    const { width: _width, height: _height, ...rest } = map;
    void _width;
    void _height;
    const unbounded = {
      ...rest,
      unbounded: true,
      pivot: { x: -1.5, y: 2 },
      layers: [{ ...map.layers[0]!, chunks: [...map.layers[0]!.chunks, chunk(-2, -1, 0, { 7: 3 })] }],
    } as unknown as TilemapFixture;
    const command = patch(map, unbounded);
    expect([...command.delta.fields!.keys].sort()).toEqual(["height", "pivot", "unbounded", "width"]);
    expect(command.delta.chunks.map(({ cx, cy, from }) => [cx, cy, from])).toEqual([[-2, -1, null]]);
    const applied = command.apply(doc(map));
    expect(applied).toEqual(unbounded);
    expect(applied).not.toHaveProperty("width");
    const reverted = command.invert().apply(applied);
    expect(reverted).toEqual(map);
    expect(reverted).not.toHaveProperty("pivot");
    // A pivot move is a field change only.
    const moved = patch(unbounded, { ...unbounded, pivot: { x: 0, y: 0.5 } } as unknown as TilemapFixture);
    expect(moved.delta).toEqual({ fields: { keys: ["pivot"], from: { pivot: { x: -1.5, y: 2 } }, to: { pivot: { x: 0, y: 0.5 } } }, chunks: [] });
  });

  it("finds unchanged documents by identity and value, and leaves documents it cannot read whole", () => {
    const map = denseMap();
    expect(diffTilemapDocument(doc(map), doc(map))).toBe("unchanged");
    expect(diffTilemapDocument(doc(map), doc({ ...map, tilesets: [{ ...map.tilesets[0]! }] }))).toBe("unchanged");
    // A copied chunk with the same cells is no change.
    expect(diffTilemapDocument(doc(map), doc(withCell(map, 0, 0, 0, 1)))).toBe("unchanged");
    const repeated = { ...map, layers: [map.layers[0]!, { ...map.layers[1]!, id: "layer-1" }] };
    expect(diffTilemapDocument(doc(map), doc(repeated))).toBe("unsupported");
    expect(diffTilemapDocument(doc(map), { layers: "none" })).toBe("unsupported");
  });

  it("replays journaled deltas onto the saved document and skips a malformed one", () => {
    const docId = "tilemap:assets/Level.tilemap.hasset";
    const map = denseMap();
    const first = withCell(map, 0, 3, 1, 4);
    const second = { ...withCell(first, 1, 2, 2, 5), width: 300 };
    const line = (command: PatchTilemapDocumentCommand) => serializeJournalLine({
      v: 1, docId, at: "2026-11-04T00:00:00Z", command: commandToJournalPayload(command),
    });
    const lines = [line(patch(map, first, "tilemap-stroke:a")), line(patch(first, second))];
    const payload = JSON.parse(lines[0]!).command as { type: string; delta: TilemapDocumentDelta; mergeKey: string };
    expect(Object.keys(payload).sort()).toEqual(["delta", "mergeKey", "type"]);
    const replayed = replayJournalLines(lines, new Map([[docId, doc(map)]]));
    expect(replayed.skipped).toEqual([]);
    expect(JSON.stringify(replayed.documents.get(docId))).toBe(JSON.stringify(second));
    const broken = serializeJournalLine({ v: 1, docId, at: "2026-11-04T00:00:01Z", command: { type: "asset.patchTilemap", delta: { chunks: [{ layer: 1 }] } } });
    const skipped = replayJournalLines([broken], new Map([[docId, doc(map)]]));
    expect(skipped.skipped).toHaveLength(1);
    expect(skipped.documents.get(docId)).toBe(map);
  });
});
