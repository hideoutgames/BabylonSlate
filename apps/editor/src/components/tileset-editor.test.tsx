import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createDefaultTilesetPayload } from "@babylonslate/assets";
import { TilesetEditingProvider } from "../context/tileset-editing-context";
import { TilesetEditor, TilesetPreview } from "./tileset-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const readAssetChunk = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
);

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "GroundAtlas", type: "Texture" },
          path: "assets/GroundAtlas.texture.babasset",
        },
      ],
    },
    readAssetChunk,
    projectDocument: {
      settings: { twoD: { sortingLayers: ["Default", "Foreground"] } },
    },
  }),
}));

afterEach(() => {
  cleanup();
  readAssetChunk.mockClear();
});

function twoTilePayload(overrides: Record<string, unknown> = {}) {
  return {
    ...createDefaultTilesetPayload(),
    atlasWidth: 32,
    atlasHeight: 16,
    tileWidth: 16,
    tileHeight: 16,
    ...overrides,
  };
}

function TilesetHarness({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [payload, setPayload] = useState(initial);
  const commit = (next: Record<string, unknown>) => {
    setPayload(next);
    onChange(next);
  };
  return (
    <TilesetEditingProvider>
      <TilesetPreview payload={payload} onChange={commit} />
      <TilesetEditor payload={payload} onChange={commit} />
    </TilesetEditingProvider>
  );
}

describe("TilesetEditor", () => {
  it("authors per-tile collision, flags, and animation", async () => {
    const payload = twoTilePayload();
    const onChange = vi.fn();
    render(
      <TilesetEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tileset-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-flags-bit-0"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, flags: 1 }),
        ]),
      }),
    );
    fireEvent.change(screen.getByTestId("property-animation"), {
      target: { value: "1, 2" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, animation: [1, 2] }),
        ]),
      }),
    );
    fireEvent.click(screen.getByTestId("property-collision"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Chain" })).toBeTruthy();
    });
    expect(screen.getByRole("option", { name: "Full" })).toBeTruthy();
  });

  it("keeps atlas size fields read-only", () => {
    render(
      <TilesetEditor
        payload={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    expect(
      (screen.getByTestId("property-atlasWidth") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("property-atlasHeight") as HTMLInputElement).disabled,
    ).toBe(true);
  });
});

describe("TilesetPreview", () => {
  it("renders a clickable cell for every atlas tile on a 32×16 sheet", () => {
    render(
      <TilesetEditingProvider>
        <TilesetPreview
          payload={twoTilePayload() as unknown as Record<string, unknown>}
        />
      </TilesetEditingProvider>,
    );
    expect(screen.getByTestId("tileset-preview")).toBeTruthy();
    expect(screen.getByTestId("tileset-preview-cell-1")).toBeTruthy();
    expect(screen.getByTestId("tileset-preview-cell-2")).toBeTruthy();
  });

  it("writes Full collision on the tile selected in the preview", () => {
    const onChange = vi.fn();
    render(
      <TilesetHarness
        initial={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("tileset-preview-cell-2"));
    expect(screen.getByTestId("tileset-selected-label").textContent).toContain(
      "2",
    );
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 2, collision: "full" }),
        ]),
      }),
    );
  });

  it("stamps the current collision onto other cells in Paint Collision mode", () => {
    const onChange = vi.fn();
    render(
      <TilesetHarness
        initial={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("tileset-preview-cell-1"));
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    fireEvent.click(screen.getByTestId("tileset-paint-collision"));
    fireEvent.click(screen.getByTestId("tileset-preview-cell-2"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 2, collision: "full" }),
        ]),
      }),
    );
  });

  it("derives atlas size from the assigned texture", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:atlas");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const onChange = vi.fn();
    render(
      <TilesetEditingProvider>
        <TilesetPreview
          payload={
            twoTilePayload({ textureGuid: "tex-1" }) as unknown as Record<
              string,
              unknown
            >
          }
          onChange={onChange}
        />
      </TilesetEditingProvider>,
    );
    const img = await waitFor(() => {
      const found = document.querySelector("img");
      expect(found).toBeTruthy();
      return found as HTMLImageElement;
    });
    Object.defineProperty(img, "naturalWidth", { value: 64 });
    Object.defineProperty(img, "naturalHeight", { value: 32 });
    fireEvent.load(img);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        atlasWidth: 64,
        atlasHeight: 32,
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1 }),
          expect.objectContaining({ id: 8 }),
        ]),
      }),
    );
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
