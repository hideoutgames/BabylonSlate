import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  ensureTilesetTiles,
  encodeTileGid,
  getTile,
  normalizeTilemapPayload,
  type TilemapPayload,
} from "@babylonslate/assets";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { TilemapEditingProvider } from "../context/tilemap-editing-context";
import {
  TilemapDetails,
  TilemapEditor,
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

const GROUND_PATH = "assets/Ground.tileset.babasset";
const PROPS_PATH = "assets/Props.tileset.babasset";

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
const documentApi = vi.hoisted(() => ({
  assetRegistry: {
    list: () => [
      {
        header: { guid: "ts-ground", name: "Ground", type: "Tileset" },
        path: "assets/Ground.tileset.babasset",
      },
      {
        header: { guid: "ts-props", name: "Props", type: "Tileset" },
        path: "assets/Props.tileset.babasset",
      },
      {
        header: { guid: "tex-1", name: "Atlas", type: "Texture" },
        path: "assets/Atlas.texture.babasset",
      },
    ],
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
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: documentApi.assetRegistry,
    openDocuments: documentApi.openDocuments,
    loadAssetDocument,
    readAssetChunk,
    projectDocument: documentApi.projectDocument,
  }),
}));

function mapWithGround(): TilemapPayload {
  return {
    ...createDefaultTilemapPayload(),
    tilesetGuid: "ts-ground",
    tilesets: [{ guid: "ts-ground", firstGid: 1, tileCount: 2 }],
  };
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
  loadAssetDocument.mockReset();
  readAssetChunk.mockClear();
});

beforeEach(() => {
  loadAssetDocument.mockImplementation(async (_kind: string, path: string) => {
    if (path === GROUND_PATH || path === PROPS_PATH) return twoTileTileset();
    return null;
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    imageSmoothingEnabled: true,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe("TilemapDetails", () => {
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
  });
});

describe("TilemapPaint", () => {
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
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const painted = normalizeTilemapPayload(onChange.mock.calls.at(-1)?.[0]);
    expect(getTile(painted, "layer-1", 0, 0)).toBe(encodeTileGid(1, 1));
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
});

describe("TilemapEditor empty state", () => {
  it("prompts to add a tileset instead of showing a blank canvas", () => {
    render(
      <TilemapEditor
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
