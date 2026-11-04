import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { diffTilemapDocument, DocumentEditStack, PatchTilemapDocumentCommand, SetAssetDocumentCommand } from "@haptic/edit";
import {
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  ensureTilesetTiles,
  encodeTileGid,
  getTile,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  refreshStaleTilemapTerrains,
  setTile,
  TERRAIN_E,
  TERRAIN_W,
  tilePlaceholderHsl,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import { AssetOpenProvider } from "@haptic/editor-kit";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { TilemapEditingProvider } from "../context/tilemap-editing-context";
import { PIVOT_MARKER_STROKE } from "../lib/tilemap-paint-renderer";
import {
  TilemapDetails,
  TilemapPaint,
  TilemapPalette,
} from "./tilemap-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const GROUND_PATH = "assets/Ground.tileset.hasset";
const PROPS_PATH = "assets/Props.tileset.hasset";
const MAP_PATH = "assets/Level.tilemap.hasset";

const twoTileTileset = () =>
  ensureTilesetTiles({
    ...createDefaultTilesetPayload(),
    textureGuid: "tex-1",
    atlasWidth: 32,
    atlasHeight: 16,
    tileWidth: 16,
    tileHeight: 16,
  });

const loadAssetDocument = vi.hoisted(() => vi.fn());
const readAssetChunk = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
);
const documentApi = vi.hoisted(() => {
  type IndexedAssetFixture = {
    header: { guid: string; name: string; type: string };
    path: string;
  };
  const api = {
    /** Registry entries keep their identity until a save or reindex replaces them. */
    assets: [] as IndexedAssetFixture[],
    assetRegistry: {
      getByGuid: (guid: string): IndexedAssetFixture | undefined =>
        api.assets.find((asset) => asset.header.guid === guid),
      list: (): IndexedAssetFixture[] => api.assets,
    },
    openDocuments: [] as Array<{
      id: string;
      ref: { kind: string; path: string };
      content: unknown;
    }>,
    projectDocument: {
      settings: {
        twoD: { sortingLayers: ["Background", "Default", "Foreground", "UI"] },
      },
    },
  };
  return api;
});

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: documentApi.assetRegistry,
  openDocuments: documentApi.openDocuments,
  loadAssetDocument,
  readAssetChunk,
  projectDocument: documentApi.projectDocument,
})));

function mapWithGround(): TilemapPayload {
  return {
    ...createDefaultTilemapPayload(),
    tilesets: [{ guid: "ts-ground", firstGid: 1, tileCount: 2 }],
  };
}

/** Details, Palette and Paint panels sharing one editing session, as in a Tilemap document. */
function TilemapDocument({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  return (
    <TilemapEditingProvider>
      <TilemapDetails payload={payload} onChange={onChange} />
      <TilemapPalette payload={payload} onChange={onChange} />
      <TilemapPaint payload={payload} onChange={onChange} />
    </TilemapEditingProvider>
  );
}

function TilemapHarness({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const [payload, setPayload] = useState(initial);
  const commit = (next: Record<string, unknown>, mergeKey?: string) => {
    // DocumentContext publishes a new open-documents list with every edit.
    documentApi.openDocuments = [
      ...documentApi.openDocuments.filter((doc) => doc.id !== "map"),
      { id: "map", ref: { kind: "tilemap", path: MAP_PATH }, content: next },
    ];
    setPayload(next);
    onChange(next, mergeKey);
  };
  return (
    <TilemapEditingProvider>
      <TilemapDetails payload={payload} onChange={commit} />
      <TilemapPalette payload={payload} />
      <TilemapPaint payload={payload} onChange={commit} />
    </TilemapEditingProvider>
  );
}

afterEach(() => {
  cleanup();
  documentApi.openDocuments = [];
  loadAssetDocument.mockReset();
  readAssetChunk.mockClear();
});

/** A save or reindex replaces the asset's registry entry. */
function reindexAsset(guid: string) {
  documentApi.assets = documentApi.assets.map((asset) =>
    asset.header.guid === guid ? { ...asset, header: { ...asset.header } } : asset,
  );
}

beforeEach(() => {
  // Each test opens a fresh project index, so no Tileset is loaded yet.
  documentApi.assets = [
    { header: { guid: "ts-ground", name: "Ground", type: "Tileset" }, path: GROUND_PATH },
    { header: { guid: "ts-props", name: "Props", type: "Tileset" }, path: PROPS_PATH },
    { header: { guid: "tex-1", name: "Atlas", type: "Texture" }, path: "assets/Atlas.texture.hasset" },
  ];
  loadAssetDocument.mockImplementation(async (_kind: string, path: string) => {
    if (path === GROUND_PATH || path === PROPS_PATH) return twoTileTileset();
    return null;
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  canvasCalls.clear();
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return recordingContext(this);
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

/** A 2D context that records every call on `canvas`, with the styles it drew in. */
function recordingContext(canvas: HTMLCanvasElement) {
  let calls = canvasCalls.get(canvas);
  if (!calls) canvasCalls.set(canvas, (calls = []));
  const ctx: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, imageSmoothingEnabled: true };
  for (const op of CANVAS_OPS) {
    ctx[op] = (...args: unknown[]) => {
      // The Paint canvas starts each frame with its transform; a chunk bitmap starts each redraw by clearing.
      const paint = canvas.dataset.testid === "tilemap-paint-canvas";
      if (paint ? op === "setTransform" : op === "clearRect") calls!.length = 0;
      calls!.push({ op, args, fill: String(ctx.fillStyle), stroke: String(ctx.strokeStyle) });
    };
  }
  return ctx;
}

const CANVAS_OPS = ["setTransform", "clearRect", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo", "stroke", "save", "restore", "clip", "rect", "strokeRect"] as const;
/** Every canvas's calls since its latest frame (Paint) or redraw (a chunk bitmap). */
const canvasCalls = new Map<HTMLCanvasElement, Array<{ op: string; args: unknown[]; fill: string; stroke: string }>>();

/**
 * The tiles the Paint canvas shows in its latest frame, as `fill x,y,w,h` in
 * canvas pixels: each chunk bitmap it composited, with the tiles that bitmap
 * was drawn with, in drawing order.
 */
function paintedTiles(): string[] {
  const canvas = screen.getByTestId("tilemap-paint-canvas") as HTMLCanvasElement;
  const tiles: string[] = [];
  for (const call of canvasCalls.get(canvas) ?? []) {
    if (call.op !== "drawImage") continue;
    const [source, sx, sy, sw, sh, dx, dy, dw, dh] = call.args as [HTMLCanvasElement, ...number[]];
    for (const fill of canvasCalls.get(source) ?? []) {
      if (fill.op !== "fillRect") continue;
      const [fx, fy, fw, fh] = fill.args as number[];
      const scaleX = dw! / sw!;
      const scaleY = dh! / sh!;
      tiles.push(`${fill.fill} ${dx! + (fx! - sx!) * scaleX},${dy! + (fy! - sy!) * scaleY},${fw! * scaleX},${fh! * scaleY}`);
    }
  }
  return tiles;
}

/** Positions of the tiles in the latest frame, without their colour. */
const paintedCells = () => paintedTiles().map((tile) => tile.slice(tile.lastIndexOf(" ") + 1));

describe("TilemapDetails", () => {
  it("cancels removal or confirms one edit erasing the tileset and its painted cells", async () => {
    const initial = setTile(mapWithGround(), "layer-1", 0, 0, 2);
    const onChange = vi.fn();
    render(<TilemapDetails payload={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("tilemap-tilesets-0-remove"));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tilemap-tilesets-0-remove"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Tileset" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as TilemapPayload;
    expect(next.tilesets).toEqual([]);
    expect(getTile(next, "layer-1", 0, 0)).toBe(0);
    expect(getTile(initial, "layer-1", 0, 0)).toBe(2);
  });

  it("hides and restores a layer without changing its tiles or the other layers", async () => {
    const payload = mapWithGround();
    payload.layers.push({ ...payload.layers[0]!, id: "layer-2", name: "Props", chunks: [] });
    const initial = setTile(setTile(payload, "layer-1", 0, 0, 1), "layer-2", 1, 0, 2);
    const onChange = vi.fn();
    render(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    await waitFor(() => screen.getByTestId("tilemap-palette-tile-2"));
    expect(paintedCells()).toEqual(["0,224,32,32", "32,224,32,32"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Props Layer" }));
    const hidden = onChange.mock.calls.at(-1)?.[0] as TilemapPayload;
    expect(hidden.layers.map((layer) => layer.visible)).toEqual([true, false]);
    expect(hidden.layers[1]?.chunks).toEqual(initial.layers[1]?.chunks);
    expect(paintedCells()).toEqual(["0,224,32,32"]);
    fireEvent.click(screen.getByRole("button", { name: "Show Props Layer" }));
    expect(paintedCells()).toEqual(["0,224,32,32", "32,224,32,32"]);
  });

  it("exposes map width and height next to tile size", () => {
    const payload = createDefaultTilemapPayload();
    const onChange = vi.fn();
    render(
      <TilemapDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect((screen.getByTestId("property-mapWidth") as HTMLInputElement).value).toBe(
      "64",
    );
    expect((screen.getByTestId("property-mapHeight") as HTMLInputElement).value).toBe(
      "64",
    );
    fireEvent.change(screen.getByTestId("property-mapWidth"), {
      target: { value: "8" },
    });
    fireEvent.blur(screen.getByTestId("property-mapWidth"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ width: 8, height: 64 }),
      expect.any(String),
    );
  });

  it("adds a second layer and exposes visibility, sorting, and parallax", () => {
    const payload = createDefaultTilemapPayload();
    const onChange = vi.fn();
    render(
      <TilemapDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tilemap-details")).toBeTruthy();
    expect(screen.getByTestId("property-layer-visible")).toBeTruthy();
    expect(screen.getByTestId("property-layer-collision")).toBeTruthy();
    expect(screen.getByTestId("property-layer-sorting")).toBeTruthy();
    expect(screen.getByTestId("property-vector3-layer-parallax")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tilemap-layers-add"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: expect.arrayContaining([
          expect.objectContaining({ name: "Ground" }),
          expect.objectContaining({ name: "Layer" }),
        ]),
      }),
    );
  });

  it("adds a second tileset from the Tilesets list", async () => {
    const onChange = vi.fn();
    render(
      <TilemapDetails
        payload={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("tilemap-tilesets-add"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-ts-props")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-item-ts-props"));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const next = onChange.mock.calls.at(-1)?.[0] as TilemapPayload;
    expect(next.tilesets.map((ref) => ref.guid)).toEqual([
      "ts-ground",
      "ts-props",
    ]);
    expect(next.tilesets[1]?.firstGid).toBe(3);
  });

  it("adds a tileset to the map as edited while that tileset loads", async () => {
    let finishProps!: (tileset: TilesetPayload) => void;
    loadAssetDocument.mockImplementation((_kind: string, path: string) =>
      path === PROPS_PATH
        ? new Promise((resolve) => { finishProps = resolve; })
        : Promise.resolve(path === GROUND_PATH ? twoTileTileset() : null),
    );
    const onChange = vi.fn();
    const view = render(
      <TilemapDetails payload={mapWithGround() as unknown as Record<string, unknown>} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("tilemap-tilesets-add"));
    fireEvent.click(await screen.findByTestId("search-item-ts-props"));
    await waitFor(() => expect(loadAssetDocument).toHaveBeenCalledWith("tileset", PROPS_PATH));
    view.rerender(
      <TilemapDetails payload={{ ...mapWithGround(), width: 8 } as unknown as Record<string, unknown>} onChange={onChange} />,
    );
    await act(async () => finishProps(twoTileTileset()));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls.at(-1)?.[0] as TilemapPayload;
    expect(next.width).toBe(8);
    expect(next.tilesets.map((ref) => ref.guid)).toEqual(["ts-ground", "ts-props"]);
  });

  it("turns a map Unbounded with a Pivot, its Painted Area and Center Pivot, and back only after asking when tiles move", async () => {
    const onChange = vi.fn();
    function DetailsHarness() {
      const [payload, setPayload] = useState<Record<string, unknown>>(
        setTile(setTile(mapWithGround(), "layer-1", 2, 1, 1), "layer-1", 5, 3, 1) as unknown as Record<string, unknown>,
      );
      return <TilemapDetails payload={payload} onChange={(next, mergeKey) => { setPayload(next); onChange(next, mergeKey); }} />;
    }
    render(<DetailsHarness />);
    const latest = () => normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect(screen.getByTestId("property-mapWidth")).toBeTruthy();
    expect(screen.queryByTestId("property-vector3-pivot")).toBeNull();

    fireEvent.click(screen.getByTestId("property-unbounded"));
    expect(latest()).toMatchObject({ unbounded: true, pivot: { x: 0, y: 0 } });
    expect(getTile(latest(), "layer-1", 5, 3)).toBe(1);
    // The size rows give way to the pivot and the painted cells' size.
    expect(screen.queryByTestId("property-mapWidth")).toBeNull();
    expect(screen.queryByTestId("property-mapHeight")).toBeNull();
    expect(screen.getByTestId("property-vector3-pivot")).toBeTruthy();
    expect(screen.getByTestId("property-paintedArea").textContent).toBe("4 × 3");

    // Cells 2..5 × 1..3 centre on map point 4, 2.5.
    fireEvent.click(screen.getByTestId("tilemap-center-pivot"));
    expect(latest().pivot).toEqual({ x: 4, y: 2.5 });
    fireEvent.change(screen.getByTestId("property-pivot-x"), { target: { value: "-3.3" } });
    fireEvent.blur(screen.getByTestId("property-pivot-x"));
    expect(latest().pivot).toEqual({ x: -3.5, y: 2.5 });
    expect(onChange.mock.lastCall![1]).toBe("tilemap:pivot");

    // Back to a size with every tile at x ≥ 0, y ≥ 0: no question, the size covers them.
    const edits = onChange.mock.calls.length;
    fireEvent.click(screen.getByTestId("property-unbounded"));
    expect(onChange).toHaveBeenCalledTimes(edits + 1);
    expect(latest()).toMatchObject({ width: 6, height: 4 });
    expect(latest()).not.toHaveProperty("pivot");
  });

  it("asks before making an unbounded map with tiles at negative cells bounded, then moves them in one edit", async () => {
    const onChange = vi.fn();
    const initial = setTile({ ...mapWithGround(), unbounded: true, pivot: { x: 0, y: 0 } }, "layer-1", -2, 1, 1);
    render(<TilemapDetails payload={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("property-unbounded"));
    expect(await screen.findByTestId("tilemap-bounded-dialog")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("property-unbounded"));
    fireEvent.click(await screen.findByRole("button", { name: "Make Bounded" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const bounded = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect(bounded).toMatchObject({ width: 1, height: 1 });
    expect(bounded).not.toHaveProperty("unbounded");
    expect(getTile(bounded, "layer-1", 0, 0)).toBe(1);
  });
});

describe("TilemapPalette", () => {
  it("loads a closed tileset and sets the paint GID from a thumb", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    const thumb = await waitFor(() => screen.getByTestId("tilemap-palette-tile-2"));
    expect(thumb.getAttribute("data-gid")).toBe("2");
    fireEvent.click(thumb);
    expect(screen.getByTestId("tilemap-paint-canvas").getAttribute("data-gid")).toBe(
      "2",
    );
    expect(loadAssetDocument).toHaveBeenCalledWith("tileset", GROUND_PATH);
    expect(readAssetChunk).toHaveBeenCalledWith("assets/Atlas.texture.hasset", "pixels");
  });

  it("revokes every atlas URL when it closes while an atlas is still loading", async () => {
    let finishAtlas!: (bytes: Uint8Array<ArrayBuffer>) => void;
    readAssetChunk.mockImplementationOnce(() => new Promise((resolve) => { finishAtlas = resolve; }));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:atlas");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const view = render(<TilemapPalette payload={mapWithGround() as unknown as Record<string, unknown>} />);
      await waitFor(() => expect(readAssetChunk).toHaveBeenCalled());
      view.unmount();
      await act(async () => finishAtlas(new Uint8Array([137, 80, 78, 71])));
      expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(
        createUrl.mock.results.map((result) => result.value),
      );
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
});

describe("TilemapPaint", () => {
  it("keeps crossing brush and eraser paths complete across successive strokes", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    await screen.findByTestId("tilemap-palette-tile-2");
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    const pointer = (
      type: "pointerdown" | "pointermove" | "pointerup",
      x: number,
      y: number,
    ) =>
      dispatchPointerEvent(canvas, type, {
        pointerId: 1,
        clientX: x * 32 + 16,
        clientY: 240 - y * 32,
      });
    for (const [tool, expected] of [
      ["brush", 1],
      ["eraser", 0],
      ["brush", 1],
    ] as const) {
      fireEvent.click(screen.getByTestId(`tilemap-tool-${tool}`));
      pointer("pointerdown", 0, 0);
      pointer("pointermove", 3, 0);
      pointer("pointermove", 0, 0);
      pointer("pointermove", 0, 2);
      pointer("pointermove", 0, 0);
      pointer("pointerup", 0, 0);
      const painted = normalizeTilemapPayload(onChange.mock.calls.at(-1)![0]);
      // Sparse moves must fill both arms, including cells revisited by a new stroke.
      expect([0, 1, 2, 3].map((x) => getTile(painted, "layer-1", x, 0))).toEqual([
        expected,
        expected,
        expected,
        expected,
      ]);
      expect([1, 2].map((y) => getTile(painted, "layer-1", 0, y))).toEqual([
        expected,
        expected,
      ]);
      expect(getTile(painted, "layer-1", 1, 1)).toBe(0);
    }
  });

  it("paints and erases a Palette terrain with one edit per stroke, re-resolving neighbours", async () => {
    // Ledge pieces by local id: 1 single, 2 left end, 3 middle, 4 right end.
    loadAssetDocument.mockImplementation(async (_kind: string, path: string) =>
      path === GROUND_PATH
        ? ensureTilesetTiles(normalizeTilesetPayload({
            textureGuid: "tex-1",
            atlasWidth: 64,
            atlasHeight: 16,
            tileWidth: 16,
            tileHeight: 16,
            terrains: [{ id: "ledge", name: "Ledge", style: "sides" }],
            tiles: [0, TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W].map((mask, at) => ({
              id: at + 1,
              terrain: { id: "ledge", mask },
            })),
          }))
        : null,
    );
    const onChange = vi.fn();
    const initial = { ...createDefaultTilemapPayload(), tilesets: [{ guid: "ts-ground", firstGid: 1, tileCount: 4 }] };
    render(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    fireEvent.click(await screen.findByTestId("tilemap-palette-terrain-ts-ground-ledge"));
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    expect(canvas.getAttribute("data-terrain")).toBe("ledge");
    expect(screen.getByTestId("tilemap-selected-label").textContent).toBe("Ground · Ledge");
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup", x: number) =>
      dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: x * 32 + 16, clientY: 208 });
    const row = () => [1, 2, 3, 4].map((x) => getTile(normalizeTilemapPayload(onChange.mock.lastCall![0]), "layer-1", x, 1));

    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    pointer("pointerdown", 1);
    pointer("pointermove", 3);
    pointer("pointerup", 3);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![1]).toMatch(/^tilemap-stroke:/);
    expect(row()).toEqual([2, 3, 4, 0]);

    // The Eraser keeps the terrain brush and turns the new end into a right end.
    fireEvent.click(screen.getByTestId("tilemap-tool-eraser"));
    pointer("pointerdown", 3);
    pointer("pointerup", 3);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(row()).toEqual([2, 4, 0, 0]);

    // Repainting cells that already resolve this way commits nothing.
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    pointer("pointerdown", 1);
    pointer("pointermove", 2);
    pointer("pointerup", 2);
    expect(onChange).toHaveBeenCalledTimes(2);

    // Picking a single tile drops the terrain brush.
    fireEvent.click(screen.getByTestId("tilemap-palette-tile-1"));
    expect(canvas.hasAttribute("data-terrain")).toBe(false);
    expect(canvas.getAttribute("data-gid")).toBe("1");
  });

  it("lists autotiles first with their coverage, paints one from Move, picks one with the Picker and shows stale cells refreshed", async () => {
    // Ledge pieces by local id: 1 single, 2 left end, 3 middle, 4 right end; 5 is a plain tile; Water has no tiles.
    const ground = ensureTilesetTiles(normalizeTilesetPayload({
      textureGuid: "tex-1",
      atlasWidth: 80,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      terrains: [{ id: "ledge", name: "Ledge", style: "sides" }, { id: "water", name: "Water", style: "blob" }],
      tiles: [0, TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W].map((mask, at) => ({ id: at + 1, terrain: { id: "ledge", mask } })),
    }));
    loadAssetDocument.mockImplementation(async (_kind: string, path: string) => (path === GROUND_PATH ? ground : null));
    // Each cell drawn as its placeholder colour and canvas position.
    const fillOf = (gid: number) => {
      const { h, s, l } = tilePlaceholderHsl(gid);
      return `hsl(${h} ${s}% ${l}%)`;
    };
    const lastFillAt = (x: number, y: number) =>
      paintedTiles().filter((tile) => tile.endsWith(` ${x},${y},32,32`)).at(-1)?.replace(",32,32", "");
    const onChange = vi.fn();
    const openAsset = vi.fn();
    // A ledge whose right end was painted as a single piece before the Tileset gained its end tile.
    let initial: TilemapPayload = { ...createDefaultTilemapPayload(), tilesets: [{ guid: "ts-ground", firstGid: 1, tileCount: 5 }] };
    initial = setTile(setTile(setTile(initial, "layer-1", 1, 1, 2), "layer-1", 2, 1, 3), "layer-1", 3, 1, 1);
    render(
      <AssetOpenProvider value={{ canOpen: () => true, openAsset }}>
        <TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={onChange} />
      </AssetOpenProvider>,
    );
    const autotiles = within(await screen.findByTestId("tilemap-palette-autotiles"));
    expect(autotiles.getByTestId("tilemap-palette-terrain-ts-ground-ledge").textContent).toContain("4 of 16");
    fireEvent.click(autotiles.getByTestId("tilemap-palette-autotile-setup-ts-ground-water"));
    expect(openAsset).toHaveBeenCalledWith("ts-ground");

    // The open map shows the right end at once (cell 3, 1 sits at 96, 192) without editing the document.
    await waitFor(() => expect(lastFillAt(96, 192)).toBe(`${fillOf(4)} 96,192`));
    expect(onChange).not.toHaveBeenCalled();
    // The next edit stores the refreshed cells, current with the Tileset.
    fireEvent.click(screen.getByRole("button", { name: "Hide Ground Layer" }));
    const stored = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect([1, 2, 3].map((x) => getTile(stored, "layer-1", x, 1))).toEqual([2, 3, 4]);
    expect(refreshStaleTilemapTerrains(stored, new Map([["ts-ground", ground]]))).toBe(stored);
    fireEvent.click(screen.getByRole("button", { name: "Show Ground Layer" }));

    const canvas = screen.getByTestId("tilemap-paint-canvas");
    expect(canvas.getAttribute("data-tool")).toBe("move");
    fireEvent.click(autotiles.getByTestId("tilemap-palette-terrain-ts-ground-ledge"));
    expect(canvas.getAttribute("data-tool")).toBe("brush");

    // The Picker on an autotile cell takes its autotile, not the single tile.
    fireEvent.click(screen.getByTestId("tilemap-palette-tile-5"));
    expect(canvas.hasAttribute("data-terrain")).toBe(false);
    fireEvent.click(screen.getByTestId("tilemap-tool-picker"));
    dispatchPointerEvent(canvas, "pointerdown", { pointerId: 1, clientX: 2 * 32 + 16, clientY: 208 });
    dispatchPointerEvent(canvas, "pointerup", { pointerId: 1, clientX: 2 * 32 + 16, clientY: 208 });
    await waitFor(() => expect(canvas.getAttribute("data-terrain")).toBe("ledge"));
  });

  it("re-derives a rectangle from where it started on every move", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    await screen.findByTestId("tilemap-palette-tile-2");
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    const pointer = (
      type: "pointerdown" | "pointermove" | "pointerup",
      x: number,
      y: number,
    ) =>
      dispatchPointerEvent(canvas, type, {
        pointerId: 1,
        clientX: x * 32 + 16,
        clientY: 240 - y * 32,
      });
    const rows = (map: TilemapPayload) =>
      [2, 1, 0].map((y) => [0, 1, 2, 3].map((x) => getTile(map, "layer-1", x, y)));
    fireEvent.click(screen.getByTestId("tilemap-tool-rect"));
    // Growing past the final shape must leave nothing behind once it shrinks.
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 3, 2);
    pointer("pointermove", 1, 0);
    pointer("pointerup", 1, 0);
    expect(rows(normalizeTilemapPayload(onChange.mock.calls.at(-1)![0]))).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, 1, 0, 0],
    ]);
    pointer("pointerdown", 2, 1);
    pointer("pointermove", 3, 2);
    pointer("pointerup", 3, 2);
    expect(rows(normalizeTilemapPayload(onChange.mock.calls.at(-1)![0]))).toEqual([
      [0, 0, 1, 1],
      [0, 0, 1, 1],
      [1, 1, 0, 0],
    ]);
  });

  it("redraws layers in project sorting order when that order changes", async () => {
    const initial = mapWithGround();
    initial.layers = [
      { ...setTile(initial, "layer-1", 0, 0, 1).layers[0]!, sortingLayer: "Props" },
      { ...setTile(initial, "layer-1", 1, 0, 2).layers[0]!, id: "back", sortingLayer: "Decals" },
    ];
    const previous = documentApi.projectDocument.settings.twoD.sortingLayers;
    documentApi.projectDocument.settings.twoD.sortingLayers = ["Default", "Decals", "Props"];
    const view = render(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={() => {}} />);
    const tileXs = () => paintedCells().map((cell) => Number(cell.split(",")[0]));
    try {
      await screen.findByTestId("tilemap-palette-tile-2");
      expect(tileXs()).toEqual([32, 0]);
      documentApi.projectDocument.settings.twoD.sortingLayers = ["Default", "Props", "Decals"];
      view.rerender(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={() => {}} />);
      expect(tileXs()).toEqual([0, 32]);
    } finally { documentApi.projectDocument.settings.twoD.sortingLayers = previous; }
  });
  it.each(["shrunk", "missing"])("does not overwrite cells with a selected tile from a %s atlas", async (state) => {
    const initial = setTile(mapWithGround(), "layer-1", 0, 0, 1);
    const onChange = vi.fn();
    const view = render(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    fireEvent.click(await screen.findByTestId("tilemap-palette-tile-2"));
    if (state === "shrunk") {
      documentApi.openDocuments = [{ id: "ground", ref: { kind: "tileset", path: GROUND_PATH }, content: createDefaultTilesetPayload() }];
    } else {
      documentApi.assets = documentApi.assets.filter((asset) => asset.header.guid !== "ts-ground");
    }
    view.rerender(<TilemapHarness initial={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    await waitFor(() => expect(screen.queryByTestId("tilemap-palette-tile-2")).toBeNull());
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    for (const type of ["pointerdown", "pointerup"] as const) dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: 16, clientY: 240 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tilemap-tool-eraser"));
    for (const type of ["pointerdown", "pointerup"] as const) dispatchPointerEvent(canvas, type, { pointerId: 2, clientX: 16, clientY: 240 });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(getTile(normalizeTilemapPayload(onChange.mock.calls.at(-1)![0]), "layer-1", 0, 0)).toBe(0);
  });
  it("refreshes a grown atlas and undoes remapping with the paint stroke", async () => {
    let initial = mapWithGround();
    initial.tilesets.push({ guid: "ts-props", firstGid: 3, tileCount: 2 });
    initial = setTile(initial, "layer-1", 0, 0, 2);
    initial = setTile(initial, "layer-1", 1, 0, 3);
    const onChange = vi.fn();
    function HistoryHarness() {
      const [doc, setDoc] = useState(initial as unknown as Record<string, unknown>);
      const [stack] = useState(() => new DocumentEditStack<Record<string, unknown>>({ maxEntries: 20, maxBytes: 1_000_000 }));
      return <>
        <button disabled={!stack.canUndo} onClick={() => setDoc(stack.undo(doc)!.doc)}>Undo Test Edit</button>
        <button disabled={!stack.canRedo} onClick={() => setDoc(stack.redo(doc)!.doc)}>Redo Test Edit</button>
        <output data-testid="stored-tilemap">{JSON.stringify(doc)}</output>
        <TilemapDocument payload={doc} onChange={(next, mergeKey) => {
          // As the document service records a Tilemap edit: its delta.
          const delta = diffTilemapDocument(doc, next);
          if (delta === "unchanged") return;
          const command = delta === "unsupported"
            ? new SetAssetDocumentCommand(doc, next, mergeKey)
            : new PatchTilemapDocumentCommand(delta, mergeKey);
          setDoc(stack.apply(doc, command).doc);
          onChange(next);
        }} />
      </>;
    }
    const view = render(<HistoryHarness />);
    fireEvent.click(await screen.findByTestId("tilemap-palette-tile-2"));
    documentApi.openDocuments = [{
      id: "ground", ref: { kind: "tileset", path: GROUND_PATH },
      content: ensureTilesetTiles({ ...twoTileTileset(), atlasWidth: 64 }),
    }];
    view.rerender(<HistoryHarness />);
    const newTile = await screen.findByTestId("tilemap-palette-tile-8");
    expect(screen.getByTestId("tilemap-paint-canvas").getAttribute("data-gid")).toBe("6");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(newTile);
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    dispatchPointerEvent(canvas, "pointerdown", { pointerId: 1, clientX: 16, clientY: 240 });
    dispatchPointerEvent(canvas, "pointermove", { pointerId: 1, clientX: 16, clientY: 208 });
    dispatchPointerEvent(canvas, "pointerup", { pointerId: 1, clientX: 16, clientY: 208 });
    const painted = await waitFor(() => {
      const stored = normalizeTilemapPayload(JSON.parse(screen.getByTestId("stored-tilemap").textContent!));
      expect(stored.tilesets[0]).toMatchObject({ firstGid: 5, tileCount: 4 });
      return stored;
    });
    expect(getTile(painted, "layer-1", 0, 0)).toBe(8);
    expect(getTile(painted, "layer-1", 1, 0)).toBe(3);
    const commits = onChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Undo Test Edit" }));
    expect(JSON.parse(screen.getByTestId("stored-tilemap").textContent!)).toEqual(initial);
    await waitFor(() => expect(screen.getByTestId("tilemap-paint-canvas").getAttribute("data-gid")).toBe("8"));
    expect(onChange).toHaveBeenCalledTimes(commits);
    expect(screen.getByRole("button", { name: "Undo Test Edit" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Redo Test Edit" }));
    expect(JSON.parse(screen.getByTestId("stored-tilemap").textContent!)).toEqual(painted);
  });

  it.each(["move", "picker"])("follows two-finger translation in %s without painting", async (tool) => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={mapWithGround() as unknown as Record<string, unknown>} onChange={onChange} />);
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    fireEvent.click(screen.getByTestId(`tilemap-tool-${tool}`));
    for (const [type, pointerId, clientX, clientY] of [
      ["pointerdown", 1, 40, 80], ["pointerdown", 2, 100, 80],
      ["pointermove", 1, 60, 110], ["pointermove", 2, 120, 110],
      ["pointerup", 1, 60, 110], ["pointerup", 2, 120, 110],
    ] as const) {
      dispatchPointerEvent(canvas, type, { pointerId, clientX, clientY });
    }
    await waitFor(() => {
      expect(Number(canvas.getAttribute("data-pan-x"))).toBeCloseTo(20);
      expect(Number(canvas.getAttribute("data-pan-y"))).toBeCloseTo(-30);
    });
    expect(Number(canvas.getAttribute("data-cell-size"))).toBe(32);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("defaults to the Move tool", async () => {
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    expect(canvas.getAttribute("data-tool")).toBe("move");
    expect(screen.getByTestId("tilemap-tool-move")).toBeTruthy();
  });

  it("pans the view with a one-finger drag in Move without writing tiles", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    expect(canvas.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(canvas, "pointerdown", {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    dispatchPointerEvent(canvas, "pointermove", {
      pointerId: 1,
      clientX: 80,
      clientY: 40,
    });
    await waitFor(() => {
      expect(Number(canvas.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("redraws a pan drag once per animation frame and lands the last position on release", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let lastFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++lastFrame, callback);
      return lastFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    try {
      render(
        <TilemapHarness
          initial={mapWithGround() as unknown as Record<string, unknown>}
          onChange={() => {}}
        />,
      );
      const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
      const pointer = (type: "pointerdown" | "pointermove" | "pointerup", x: number) =>
        dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: x, clientY: 40 });
      frames.clear();
      pointer("pointerdown", 40);
      pointer("pointermove", 60);
      pointer("pointermove", 80);
      expect(frames.size).toBe(1);
      expect(canvas.getAttribute("data-pan-x")).toBe("0");
      act(() => {
        for (const callback of [...frames.values()]) callback(0);
        frames.clear();
      });
      await waitFor(() => expect(canvas.getAttribute("data-pan-x")).toBe("40"));
      pointer("pointermove", 120);
      expect(frames.size).toBe(1);
      pointer("pointerup", 120);
      expect(frames.size).toBe(0);
      await waitFor(() => expect(canvas.getAttribute("data-pan-x")).toBe("80"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps pointer cells with a zoomed cell size", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    expect(canvas.getAttribute("data-cell-size")).toBe("32");
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    expect(canvas.getAttribute("data-tool")).toBe("brush");
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    for (const type of ["pointerdown", "pointerup"] as const) {
      dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: 16, clientY: 240 });
    }
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const painted = normalizeTilemapPayload(onChange.mock.calls.at(-1)?.[0]);
    expect(getTile(painted, "layer-1", 0, 0)).toBe(encodeTileGid(1, 1));
  });

  it("paints inside the map bounds and ignores cells outside", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={
          {
            ...mapWithGround(),
            width: 2,
            height: 2,
          } as unknown as Record<string, unknown>
        }
        onChange={onChange}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    for (const type of ["pointerdown", "pointerup"] as const) {
      dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: 16, clientY: 240 });
    }
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(
      getTile(
        normalizeTilemapPayload(onChange.mock.calls.at(-1)?.[0]),
        "layer-1",
        0,
        0,
      ),
    ).toBe(encodeTileGid(1, 1));
    // A stroke entirely outside the 2x2 map changes nothing, so it adds no edit.
    for (const type of ["pointerdown", "pointerup"] as const) {
      dispatchPointerEvent(canvas, type, { pointerId: 2, clientX: 80, clientY: 240 });
    }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops an in-progress paint stroke when a second finger lands", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    dispatchPointerEvent(canvas, "pointerdown", {
      pointerId: 1,
      clientX: 16,
      clientY: 240,
    });
    dispatchPointerEvent(canvas, "pointerdown", {
      pointerId: 2,
      clientX: 80,
      clientY: 240,
    });
    for (const pointerId of [2, 1]) {
      dispatchPointerEvent(canvas, "pointerup", { pointerId, clientX: 16, clientY: 240 });
    }
    expect(onChange).not.toHaveBeenCalled();
    // The next stroke starts from the unpainted map, not the dropped stroke.
    for (const type of ["pointerdown", "pointerup"] as const) {
      dispatchPointerEvent(canvas, type, { pointerId: 3, clientX: 48, clientY: 240 });
    }
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const painted = normalizeTilemapPayload(onChange.mock.calls[0]![0]);
    expect(getTile(painted, "layer-1", 1, 0)).toBe(encodeTileGid(1, 1));
    expect(getTile(painted, "layer-1", 0, 0)).toBe(0);
  });

  it("pinches to change the paint cell size", async () => {
    const onChange = vi.fn();
    render(
      <TilemapHarness
        initial={mapWithGround() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    HTMLElement.prototype.setPointerCapture = () => {
      throw new DOMException("No active pointer with the given id is found.");
    };
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    dispatchPointerEvent(canvas, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(canvas, "pointerdown", {
      pointerId: 2,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(canvas, "pointermove", {
      pointerId: 1,
      clientX: 40,
      clientY: 80,
    });
    dispatchPointerEvent(canvas, "pointermove", {
      pointerId: 2,
      clientX: 160,
      clientY: 80,
    });
    await waitFor(() => {
      expect(Number(canvas.getAttribute("data-cell-size") ?? "32")).toBeGreaterThan(
        32,
      );
    });
  });

  it("zooms from the wheel, including on a canvas shown after the first Tileset is added", async () => {
    const { rerender } = render(
      <TilemapPaint payload={createDefaultTilemapPayload() as unknown as Record<string, unknown>} onChange={() => {}} />,
    );
    expect(screen.queryByTestId("tilemap-paint-canvas")).toBeNull();
    rerender(<TilemapPaint payload={mapWithGround() as unknown as Record<string, unknown>} onChange={() => {}} />);
    const canvas = await waitFor(() => screen.getByTestId("tilemap-paint-canvas"));
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256, toJSON: () => {} }) as DOMRect;
    const before = Number(canvas.getAttribute("data-cell-size"));

    // React's wheel listener is passive and cannot cancel the page scroll; fireEvent
    // returns false only when a listener cancelled the event.
    expect(fireEvent.wheel(canvas, { deltaY: -120, clientX: 100, clientY: 100 })).toBe(false);
    await waitFor(() => expect(Number(canvas.getAttribute("data-cell-size"))).toBeGreaterThan(before));
  });
});

describe("Tilemap Tileset loading", () => {
  function mapWithGroundAndProps(): Record<string, unknown> {
    const map = mapWithGround();
    map.tilesets.push({ guid: "ts-props", firstGid: 3, tileCount: 2 });
    return map as unknown as Record<string, unknown>;
  }

  it("reads each closed Tileset once for Details, Paint and a Palette opened later", async () => {
    const payload = mapWithGroundAndProps();
    const panels = (withPalette: boolean) => (
      <TilemapEditingProvider>
        <TilemapDetails payload={payload} onChange={() => {}} />
        <TilemapPaint payload={payload} onChange={() => {}} />
        {withPalette ? <TilemapPalette payload={payload} /> : null}
      </TilemapEditingProvider>
    );
    const view = render(panels(false));
    await waitFor(() =>
      expect(screen.getByTestId("tilemap-selected-label").textContent).toBe("Ground · Tile 1"),
    );
    view.rerender(panels(true));
    // The new panel draws the document's loaded Tilesets at once.
    expect(screen.getByTestId("tilemap-palette-tile-4")).toBeTruthy();
    expect(loadAssetDocument.mock.calls).toEqual([
      ["tileset", GROUND_PATH],
      ["tileset", PROPS_PATH],
    ]);
  });

  it("paints several cells without reading closed Tilesets again", async () => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={mapWithGroundAndProps()} onChange={onChange} />);
    await screen.findByTestId("tilemap-palette-tile-4");
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    dispatchPointerEvent(canvas, "pointerdown", { pointerId: 1, clientX: 16, clientY: 240 });
    for (const x of [1, 2, 3]) {
      dispatchPointerEvent(canvas, "pointermove", { pointerId: 1, clientX: x * 32 + 16, clientY: 240 });
    }
    dispatchPointerEvent(canvas, "pointerup", { pointerId: 1, clientX: 112, clientY: 240 });
    await act(async () => {});
    const painted = normalizeTilemapPayload(onChange.mock.calls.at(-1)![0]);
    expect([0, 1, 2, 3].map((x) => getTile(painted, "layer-1", x, 0))).toEqual([1, 1, 1, 1]);
    expect(loadAssetDocument).toHaveBeenCalledTimes(2);
  });

  it("shows every edit of an open Tileset without reading storage", async () => {
    const openGround = (content: unknown) => {
      documentApi.openDocuments = [{ id: "ground", ref: { kind: "tileset", path: GROUND_PATH }, content }];
    };
    const initial = mapWithGround() as unknown as Record<string, unknown>;
    openGround(twoTileTileset());
    const view = render(<TilemapHarness initial={initial} onChange={() => {}} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    openGround(ensureTilesetTiles({ ...twoTileTileset(), atlasWidth: 64 }));
    view.rerender(<TilemapHarness initial={initial} onChange={() => {}} />);
    await screen.findByTestId("tilemap-palette-tile-4");
    openGround(createDefaultTilesetPayload());
    view.rerender(<TilemapHarness initial={initial} onChange={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("tilemap-palette-tile-2")).toBeNull());
    expect(screen.getByTestId("tilemap-palette-tile-1")).toBeTruthy();
    expect(loadAssetDocument).not.toHaveBeenCalled();
  });

  it("reads a closed Tileset again once a save replaces its registry entry", async () => {
    const initial = mapWithGroundAndProps();
    const view = render(<TilemapHarness initial={initial} onChange={() => {}} />);
    await screen.findByTestId("tilemap-palette-tile-4");
    loadAssetDocument.mockImplementation(async (_kind: string, path: string) =>
      path === GROUND_PATH ? ensureTilesetTiles({ ...twoTileTileset(), atlasWidth: 64 }) : twoTileTileset(),
    );
    reindexAsset("ts-ground");
    view.rerender(<TilemapHarness initial={initial} onChange={() => {}} />);
    // Ground grew past the Props range, so its four tiles move to GIDs 5-8.
    await screen.findByTestId("tilemap-palette-tile-8");
    expect(loadAssetDocument.mock.calls).toEqual([
      ["tileset", GROUND_PATH],
      ["tileset", PROPS_PATH],
      ["tileset", GROUND_PATH],
    ]);
  });
});

describe("Tilemap editor views", () => {
  /** A two-layer map with tiles on the second layer. */
  function twoLayerMap(): TilemapPayload {
    const payload = mapWithGround();
    payload.layers.push({ ...payload.layers[0]!, id: "layer-2", name: "Props", chunks: [] });
    return setTile(payload, "layer-2", 1, 0, 2);
  }

  it("previews a Rect as an outline without editing the map, then paints it in one edit on release", async () => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={mapWithGround() as unknown as Record<string, unknown>} onChange={onChange} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    fireEvent.click(screen.getByTestId("tilemap-tool-rect"));
    const canvas = screen.getByTestId("tilemap-paint-canvas") as HTMLCanvasElement;
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) =>
      act(() => dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: x * 32 + 16, clientY: 240 - y * 32 }));
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 3, 2);
    pointer("pointermove", 3, 2);
    // The shape outline, in the selection orange, over the map.
    const outline = () => (canvasCalls.get(canvas) ?? []).find((call) => call.op === "strokeRect" && call.stroke === "oklch(0.75 0.17 60)");
    // Cells 0-3 × 0-2: 128 × 96 px from the canvas's bottom-left, inset by the 2 px outline.
    await waitFor(() => expect(outline()?.args).toEqual([1, 256 - 96 + 1, 126, 94]));
    expect(paintedTiles()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    pointer("pointerup", 3, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    const painted = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect([0, 1, 2].map((y) => [0, 1, 2, 3, 4].map((x) => getTile(painted, "layer-1", x, y)))).toEqual([
      [1, 1, 1, 1, 0], [1, 1, 1, 1, 0], [1, 1, 1, 1, 0],
    ]);
    await waitFor(() => expect(outline()).toBeUndefined());
  });

  it("reads out the map cell under a hovering mouse and nothing outside the map", async () => {
    render(<TilemapHarness initial={{ ...mapWithGround(), width: 5, height: 5 } as unknown as Record<string, unknown>} onChange={() => {}} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    const hover = (x: number, y: number) =>
      act(() => dispatchPointerEvent(canvas, "pointermove", { pointerType: "mouse", clientX: x, clientY: y }));
    expect(screen.queryByTestId("tilemap-paint-hover-cell")).toBeNull();
    hover(3 * 32 + 16, 256 - 2 * 32 - 16);
    expect(screen.getByTestId("tilemap-paint-hover-cell").textContent).toBe("3, 2");
    expect(screen.getByTestId("tilemap-paint-hover-cell").getAttribute("aria-label")).toBe("Cell 3, 2");
    hover(7 * 32 + 16, 240);
    expect(screen.queryByTestId("tilemap-paint-hover-cell")).toBeNull();
    // A painting finger reads out its cell until it lifts.
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const touch = (type: "pointerdown" | "pointerup") =>
      act(() => dispatchPointerEvent(canvas, type, { pointerId: 2, pointerType: "touch", clientX: 32 + 16, clientY: 240 }));
    touch("pointerdown");
    expect(screen.getByTestId("tilemap-paint-hover-cell").textContent).toBe("1, 0");
    touch("pointerup");
    expect(screen.queryByTestId("tilemap-paint-hover-cell")).toBeNull();
  });

  /** An unbounded map with its pivot at map point 1, 1 and a tile at cell -2, -1. */
  function unboundedMap(): TilemapPayload {
    return setTile({ ...mapWithGround(), unbounded: true, pivot: { x: 1, y: 1 } }, "layer-1", -2, -1, 2);
  }

  it("opens an unbounded map centred on its pivot, draws its negative chunks and paints and reads out any cell", async () => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={unboundedMap() as unknown as Record<string, unknown>} onChange={onChange} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    // The 256 px canvas puts map point 1, 1 at its centre, at 32 px a cell.
    expect([canvas.getAttribute("data-pan-x"), canvas.getAttribute("data-pan-y")]).toEqual(["96", "96"]);
    await waitFor(() => expect(paintedCells()).toEqual(["32,160,32,32"]));
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    for (const type of ["pointerdown", "pointerup"] as const) dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: 16, clientY: 240 });
    expect(getTile(normalizeTilemapPayload(onChange.mock.lastCall![0]), "layer-1", -3, -3)).toBe(1);
    act(() => dispatchPointerEvent(canvas, "pointermove", { pointerType: "mouse", clientX: 16, clientY: 240 }));
    expect(screen.getByTestId("tilemap-paint-hover-cell").textContent).toBe("-3, -3");
  });

  it("drags the pivot marker in one edit that paints nothing, and a press on it that lifts in place paints", async () => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={unboundedMap() as unknown as Record<string, unknown>} onChange={onChange} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const canvas = screen.getByTestId("tilemap-paint-canvas") as HTMLCanvasElement;
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, pointerId = 1) =>
      act(() => dispatchPointerEvent(canvas, type, { pointerId, clientX: x, clientY: y }));
    const marker = () => (canvasCalls.get(canvas) ?? [])
      .filter((call) => call.op === "strokeRect" && call.stroke === PIVOT_MARKER_STROKE).at(-1)?.args;
    // Map point 1, 1 is canvas point 128, 128; a finger 20 px off still takes the marker.
    await waitFor(() => expect(marker()).toEqual([122, 122, 12, 12]));
    pointer("pointerdown", 148, 128);
    pointer("pointermove", 176, 128);
    pointer("pointermove", 192, 96);
    // The marker follows to map point 3, 2, and nothing is edited before the finger lifts.
    await waitFor(() => expect(marker()).toEqual([186, 90, 12, 12]));
    expect(onChange).not.toHaveBeenCalled();
    pointer("pointerup", 192, 96);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![1]).toMatch(/^tilemap:pivot-drag:/);
    const moved = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect(moved.pivot).toEqual({ x: 3, y: 2 });
    expect(moved.layers).toEqual(unboundedMap().layers);

    // A mouse finds the marker only on its arms.
    const hover = (x: number) => act(() => dispatchPointerEvent(canvas, "pointermove", { pointerType: "mouse", clientX: x, clientY: 96 }));
    hover(192 + 10);
    expect(canvas.style.cursor).toBe("move");
    hover(192 + 20);
    expect(canvas.style.cursor).toBe("");

    // A press on the marker that lifts in place is a Brush press on the cell under it.
    pointer("pointerdown", 192, 96, 2);
    pointer("pointerup", 192, 96, 2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(getTile(normalizeTilemapPayload(onChange.mock.lastCall![0]), "layer-1", 3, 2)).toBe(1);

    // A second finger drops a drag without an edit.
    pointer("pointerdown", 192, 96, 3);
    pointer("pointermove", 230, 60, 3);
    pointer("pointerdown", 40, 40, 4);
    pointer("pointerup", 230, 60, 3);
    pointer("pointerup", 40, 40, 4);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("paints the layer picked in the Inspector, and says when that layer is hidden", async () => {
    const onChange = vi.fn();
    render(<TilemapHarness initial={twoLayerMap() as unknown as Record<string, unknown>} onChange={onChange} />);
    await screen.findByTestId("tilemap-palette-tile-2");
    const paintLayer = () => screen.getByTestId("tilemap-paint-layer");
    expect(paintLayer().getAttribute("aria-label")).toBe("Paint Layer: Ground");
    fireEvent.click(screen.getByTestId("tilemap-layer-layer-2"));
    expect(paintLayer().getAttribute("aria-label")).toBe("Paint Layer: Props");
    expect((screen.getByTestId("property-layer-name") as HTMLInputElement).value).toBe("Props");
    expect(screen.queryByTestId("tilemap-paint-layer-hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide Props Layer" }));
    expect(paintLayer().getAttribute("aria-label")).toBe("Paint Layer: Props (Hidden)");
    expect(screen.getByTestId("tilemap-paint-layer-hidden").textContent).toBe("Layer Hidden");
    // A stroke still writes the layer it names.
    fireEvent.click(screen.getByTestId("tilemap-tool-brush"));
    const canvas = screen.getByTestId("tilemap-paint-canvas");
    for (const type of ["pointerdown", "pointerup"] as const) dispatchPointerEvent(canvas, type, { pointerId: 1, clientX: 16, clientY: 240 });
    const painted = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect(getTile(painted, "layer-2", 0, 0)).toBe(1);
    expect(getTile(painted, "layer-1", 0, 0)).toBe(0);
  });

  it("re-cuts the painted cells on a new Chunk Size without moving them", () => {
    let initial: TilemapPayload = { ...mapWithGround(), chunkSize: 4 };
    for (const [x, y, gid] of [[0, 0, 1], [5, 1, 2], [9, 7, 1]] as const) initial = setTile(initial, "layer-1", x, y, gid);
    const onChange = vi.fn();
    render(<TilemapDetails payload={initial as unknown as Record<string, unknown>} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("property-chunkSize"), { target: { value: "3" } });
    fireEvent.blur(screen.getByTestId("property-chunkSize"));
    const next = normalizeTilemapPayload(onChange.mock.lastCall![0]);
    expect(onChange.mock.lastCall![1]).toBe("tilemap:chunkSize");
    expect(next.chunkSize).toBe(3);
    expect(next.layers[0]!.chunks.every((chunk) => chunk.tiles.length === 9)).toBe(true);
    expect([[0, 0], [5, 1], [9, 7], [1, 1]].map(([x, y]) => getTile(next, "layer-1", x!, y!))).toEqual([1, 2, 1, 0]);
  });

  it("decodes each atlas once for the Palette and Paint, and draws Palette tiles from it", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:ground-atlas");
    const images: Array<{ onload: (() => void) | null; src: string }> = [];
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      naturalWidth = 32;
      naturalHeight = 16;
      #src = "";
      constructor() {
        images.push(this);
      }
      get src() {
        return this.#src;
      }
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => this.onload?.());
      }
    });
    try {
      render(<TilemapHarness initial={mapWithGround() as unknown as Record<string, unknown>} onChange={() => {}} />);
      const canvas = await screen.findByTestId("tilemap-paint-canvas");
      await waitFor(() => expect(canvas.getAttribute("data-paint-source")).toBe("atlas"));
      expect(readAssetChunk).toHaveBeenCalledTimes(1);
      expect(images).toHaveLength(1);
      // Tile 2 is the right half of the 32 × 16 atlas.
      const sprite = screen.getByTestId("tilemap-palette-tile-2").querySelector("[data-tile-sprite]") as HTMLElement;
      expect(sprite.style.backgroundImage).toContain("blob:ground-atlas");
      expect(sprite.style.backgroundSize).toBe("200% 100%");
      expect(sprite.style.backgroundPosition).toBe("100% 0%");
    } finally {
      createUrl.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("mounts only the Palette tiles in view of a large sheet, and follows the scroll", async () => {
    loadAssetDocument.mockImplementation(async (_kind: string, path: string) =>
      path === GROUND_PATH ? ensureTilesetTiles({ ...createDefaultTilesetPayload(), atlasWidth: 2048, atlasHeight: 2048 }) : null,
    );
    const restore: Array<() => void> = [];
    const stub = (key: "clientWidth" | "clientHeight" | "offsetTop", value: (testId: string | null) => number) => {
      const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return value(this.getAttribute("data-testid"));
        },
      });
      restore.push(() => {
        if (previous) Object.defineProperty(HTMLElement.prototype, key, previous);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
      });
    };
    stub("clientWidth", (id) => (id === "tilemap-palette-grid-ts-ground" ? 400 : 0));
    stub("clientHeight", (id) => (id === "tilemap-palette-scroll" ? 200 : 0));
    stub("offsetTop", (id) => (id === "tilemap-palette-grid-ts-ground" ? 60 : 0));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    try {
      const map = { ...createDefaultTilemapPayload(), tilesets: [{ guid: "ts-ground", firstGid: 1, tileCount: 16384 }] };
      render(<TilemapHarness initial={map as unknown as Record<string, unknown>} onChange={() => {}} />);
      await screen.findByTestId("tilemap-palette-tile-1");
      const mounted = () => screen.getAllByTestId(/^tilemap-palette-tile-\d+$/).map((tile) => Number(tile.dataset.gid));
      // 9 columns of 36 px fit 384 px; 200 px of view shows 4 rows, and 4 more each way are kept.
      expect(mounted().length).toBeLessThanOrEqual(9 * 8);
      expect(mounted()[0]).toBe(1);
      const scroller = screen.getByTestId("tilemap-palette-scroll");
      scroller.scrollTop = 60 + 1000 * ((384 - 8 * 4) / 9 + 4);
      act(() => {
        fireEvent.scroll(scroller);
      });
      expect(mounted()).toContain(1000 * 9 + 1);
      expect(mounted()).not.toContain(1);
      expect(mounted().length).toBeLessThanOrEqual(9 * 14);
      expect(screen.getByTestId("tilemap-palette-group-ts-ground").textContent).toContain("16384");
    } finally {
      while (restore.length) restore.pop()!();
      vi.unstubAllGlobals();
    }
  });
});

describe("Tilemap document empty state", () => {
  it("prompts to add a tileset instead of showing a blank canvas", () => {
    render(
      <TilemapDocument
        payload={createDefaultTilemapPayload() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    expect(screen.getAllByText("Add a Tileset to start painting.").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByTestId("tilemap-paint-canvas")).toBeNull();
  });
});
