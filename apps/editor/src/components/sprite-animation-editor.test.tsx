import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssetOpenProvider } from "@haptic/editor-kit";
import {
  AssetRegistry,
  createDefaultSpriteAnimationPayload,
  projectContentRoot,
} from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import {
  SpriteAnimationDetails,
  SpriteAnimationPreview,
} from "./sprite-animation-editor";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

function pngIhdr(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const readAssetChunk = vi.fn(async () => pngIhdr(200, 100));
const heroSprite = {
  textureGuid: "tex-2",
  pivot: { x: 0.5, y: 1 },
  collision: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
};
const loadAssetDocument = vi.fn(async (_kind: string, path: string) => (path.includes("Hero.sprite") ? heroSprite : null));
let assetRegistry: AssetRegistry;

beforeAll(async () => {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("animation-preview.hproject");
  assetRegistry = new AssetRegistry(storage);
  await assetRegistry.mountRoot(projectContentRoot());
  for (const asset of [
    { guid: "tex-1", name: "HeroAtlas", type: "Texture", payload: {} },
    { guid: "tex-2", name: "HeroRun", type: "Texture", payload: { width: 48, height: 64 } },
    { guid: "tex-sheet", name: "RunSheet", type: "Texture", payload: { width: 64, height: 32 } },
    { guid: "sprite-1", name: "Hero", type: "Sprite", payload: {} },
    { guid: "mesh-1", name: "Cube", type: "Mesh", payload: {} },
  ]) {
    await assetRegistry.createAsset(
      "project",
      `${asset.name}.${asset.type.toLowerCase()}.hasset`,
      { ...asset, version: 1, dependencies: [], chunks: [] },
    );
  }
});

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry,
  readAssetChunk,
  loadAssetDocument,
})));

afterEach(() => {
  cleanup();
  readAssetChunk.mockClear();
  loadAssetDocument.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SpriteAnimation editor", () => {
  it("identifies a missing frame texture without a loading dead end", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frames[0]!.textureGuid = "missing";
    render(<SpriteAnimationPreview payload={payload as unknown as Record<string, unknown>} />);
    expect(screen.getByText("Missing Texture")).toBeTruthy();
    expect(screen.queryByText(/Loading texture/i)).toBeNull();
  });
  it("lets the author pick a Texture or a Sprite for the current frame", async () => {
    const payload = createDefaultSpriteAnimationPayload();
    const onChange = vi.fn();
    render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("sprite-animation-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-image"));
    expect(await screen.findByTestId("search-item-tex-1")).toBeTruthy();
    expect(screen.getByTestId("search-item-sprite-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-mesh-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    const texture = onChange.mock.calls.at(-1)?.[0] as { frames: Array<Record<string, unknown>> };
    expect(texture.frames[0]).toMatchObject({ textureGuid: "tex-1" });
    expect(texture.frames[0]?.spriteGuid).toBeUndefined();
    fireEvent.click(screen.getByTestId("property-image"));
    fireEvent.click(await screen.findByTestId("search-item-sprite-1"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ frames: [expect.objectContaining({ spriteGuid: "sprite-1", textureGuid: "" })] }),
    );
  });

  it("shows a Sprite frame's pivot and collision from the Sprite, read-only, with Open Sprite", async () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frames[0] = { ...payload.frames[0]!, spriteGuid: "sprite-1" };
    const openAsset = vi.fn();
    render(
      <AssetOpenProvider value={{ canOpen: () => true, openAsset }}>
        <SpriteAnimationDetails payload={payload as unknown as Record<string, unknown>} onChange={vi.fn()} />
        <SpriteAnimationPreview payload={payload as unknown as Record<string, unknown>} onChange={vi.fn()} />
      </AssetOpenProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sprite-pivot-marker").style.top).toBe("100%"));
    expect(loadAssetDocument).toHaveBeenCalledWith("sprite", "assets/Hero.sprite.hasset");
    expect(screen.getByTestId("property-image").textContent).toContain("Hero");
    expect(screen.getByText("Pivot and Collision come from the Sprite.")).toBeTruthy();
    for (const row of ["pivot", "collision"]) {
      const inputs = [...screen.getByTestId(`property-row-${row}`).querySelectorAll("input")];
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => input.disabled)).toBe(true);
    }
    // The collision box shows the Sprite's and has no handles to drag.
    const box = screen.getByTestId("sprite-collision-overlay");
    expect(box.getAttribute("data-read-only")).toBe("true");
    expect(box.style.left).toBe("25%");
    expect(screen.queryByTestId("sprite-collision-handle-se")).toBeNull();
    // The preview box takes the Sprite Texture's 48 x 64 shape.
    expect(screen.getByTestId("sprite-animation-image-box").style.width).toBe("75%");
    fireEvent.click(screen.getByTestId("sprite-animation-open-sprite"));
    expect(openAsset).toHaveBeenCalledWith("sprite-1");
  });

  it("switches to a sheet, keeps each frame as a cell and fills the frames with every cell", async () => {
    const payload = {
      ...createDefaultSpriteAnimationPayload(),
      frames: [
        { ...createDefaultSpriteAnimationPayload().frames[0]!, textureGuid: "tex-sheet" },
        { ...createDefaultSpriteAnimationPayload().frames[0]!, textureGuid: "tex-sheet" },
      ],
    };
    const onChange = vi.fn();
    const view = render(
      <SpriteAnimationDetails payload={payload as unknown as Record<string, unknown>} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("property-source"));
    const option = await screen.findByRole("option", { name: "Sheet" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    const sheet = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown> & { frames: Array<{ cell?: number }> };
    expect(sheet).toMatchObject({ source: "sheet", sheet: { textureGuid: "tex-sheet", cellWidth: 32, cellHeight: 32 } });
    expect(sheet.frames.map((frame) => frame.cell)).toEqual([1, 2]);
    view.rerender(<SpriteAnimationDetails payload={{ ...sheet, sheet: { ...(sheet.sheet as object), cellWidth: 16 } }} onChange={onChange} />);
    // A 64 x 32 Texture holds four 16 x 32 cells.
    expect(screen.getByTestId("sprite-animation-cell-count").textContent).toBe("4 Cells");
    expect(screen.getByTestId("property-cell")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sprite-animation-use-all-cells"));
    const filled = onChange.mock.calls.at(-1)?.[0] as { frames: Array<{ cell?: number }> };
    expect(filled.frames.map((frame) => frame.cell)).toEqual([1, 2, 3, 4]);
  });

  it("crops the preview to the frame's sheet cell and sets a cell from the Sheet view", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sheet");
    const payload = {
      ...createDefaultSpriteAnimationPayload(),
      source: "sheet",
      sheet: { textureGuid: "tex-sheet", cellWidth: 16, cellHeight: 16, margin: 0, spacing: 0 },
      frames: [{ ...createDefaultSpriteAnimationPayload().frames[0]!, cell: 6 }],
    };
    const onChange = vi.fn();
    render(<SpriteAnimationPreview payload={payload as unknown as Record<string, unknown>} onChange={onChange} />);
    const box = screen.getByTestId("sprite-animation-image-box");
    await waitFor(() => expect(box.querySelector("img")).toBeTruthy());
    // Cell 6 of a 4 x 2 grid is the second cell of the second row.
    const image = box.querySelector("img")!;
    expect(image.style.left).toBe("-100%");
    expect(image.style.top).toBe("-100%");
    expect(image.style.width).toBe("400%");
    expect(image.style.height).toBe("200%");
    fireEvent.click(screen.getByTestId("sprite-animation-view-sheet"));
    expect(screen.getByTestId("sprite-animation-sheet-cell-6").getAttribute("data-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("sprite-animation-sheet-cell-3"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ frames: [expect.objectContaining({ cell: 3 })] }));
  });

  it("loads every frame Texture before playing and never reloads one while it plays", async () => {
    const listAssets = vi.spyOn(assetRegistry, "list");
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:animation-texture-${Math.random()}`);
    let now = 0;
    const raf = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      raf.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      raf.delete(id);
    });
    const flush = (advanceMs: number) => {
      now += advanceMs;
      const queued = [...raf.values()];
      raf.clear();
      for (const callback of queued) callback(now);
    };

    const payload = {
      frames: [
        {
          textureGuid: "tex-1",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
        },
        {
          textureGuid: "tex-2",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };
    render(
      <SpriteAnimationPreview
        payload={payload as unknown as Record<string, unknown>}
      />,
    );
    const preview = screen.getByTestId("sprite-animation-preview");
    expect(preview.getAttribute("data-playing")).toBe("false");
    expect(preview.getAttribute("data-frame-index")).toBe("0");
    // The main image and both frame thumbnails.
    await waitFor(() => {
      expect(preview.querySelectorAll("img")).toHaveLength(3);
    });
    expect(readAssetChunk).toHaveBeenCalledWith("assets/HeroAtlas.texture.hasset", "pixels");
    expect(readAssetChunk).toHaveBeenCalledWith("assets/HeroRun.texture.hasset", "pixels");
    const firstUrl = screen.getByTestId("sprite-animation-image-box").querySelector("img")!.getAttribute("src");
    const secondUrl = screen.getByTestId("sprite-animation-frame-1").querySelector("img")!.getAttribute("src");
    readAssetChunk.mockClear();

    fireEvent.click(screen.getByTestId("sprite-animation-play"));
    expect(preview.getAttribute("data-playing")).toBe("true");
    act(() => {
      flush(25);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("0");
    act(() => {
      flush(125);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("1");
    // The next frame shows the image loaded before Play, at once.
    expect(screen.getByTestId("sprite-animation-image-box").querySelector("img")!.getAttribute("src")).toBe(secondUrl);
    expect(screen.queryByText(/Loading Texture/i)).toBeNull();
    act(() => {
      flush(100);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("0");
    expect(screen.getByTestId("sprite-animation-image-box").querySelector("img")!.getAttribute("src")).toBe(firstUrl);
    expect(readAssetChunk).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sprite-animation-pause"));
    expect(preview.getAttribute("data-playing")).toBe("false");
    act(() => {
      flush(200);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("0");
    expect(listAssets).not.toHaveBeenCalled();
  });

  it("keeps the playback position on one line", () => {
    const payload = createDefaultSpriteAnimationPayload();
    render(<SpriteAnimationPreview payload={payload as unknown as Record<string, unknown>} />);
    const position = screen.getByTestId("sprite-animation-position");
    expect(position.className).toContain("whitespace-nowrap");
    expect(position.textContent).toBe("Frame 1/1 · 0/100 ms");
  });

  it("pauses and seeks when the frame strip is clicked", () => {
    const payload = {
      frames: [
        {
          textureGuid: "a",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
        },
        {
          textureGuid: "b",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };
    render(
      <SpriteAnimationPreview
        payload={payload as unknown as Record<string, unknown>}
      />,
    );
    fireEvent.click(screen.getByTestId("sprite-animation-play"));
    fireEvent.click(screen.getByTestId("sprite-animation-frame-1"));
    const preview = screen.getByTestId("sprite-animation-preview");
    expect(preview.getAttribute("data-playing")).toBe("false");
    expect(preview.getAttribute("data-frame-index")).toBe("1");
  });

  it("edits Frame Duration on the animation payload", () => {
    const payload = createDefaultSpriteAnimationPayload();
    const onChange = vi.fn();
    render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("property-frame-duration"), {
      target: { value: "40" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ frameDurationMs: 40 }),
      expect.any(String),
    );
  });

  it("hides per-frame duration until Frame Duration Override is on and seeds the global value", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frameDurationMs = 40;
    const onChange = vi.fn();
    const { rerender } = render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("property-frame-duration-override")).toBeTruthy();
    expect(screen.queryByTestId("property-override-frame-duration")).toBeNull();
    fireEvent.click(screen.getByTestId("property-frame-duration-override"));
    const next = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(next).toEqual(
      expect.objectContaining({
        frameDurationMs: 40,
        frames: [
          expect.objectContaining({
            durationMsOverride: true,
            durationMs: 40,
          }),
        ],
      }),
    );
    rerender(
      <SpriteAnimationDetails payload={next} onChange={onChange} />,
    );
    expect(screen.getByTestId("property-override-frame-duration")).toBeTruthy();
  });

  it("does not rewrite an overridden frame duration when the global duration changes", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frameDurationMs = 40;
    payload.frames[0] = {
      ...payload.frames[0]!,
      durationMsOverride: true,
      durationMs: 120,
    };
    const onChange = vi.fn();
    render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("property-frame-duration"), {
      target: { value: "80" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        frameDurationMs: 80,
        frames: [
          expect.objectContaining({
            durationMsOverride: true,
            durationMs: 120,
          }),
        ],
      }),
      expect.any(String),
    );
  });

  it("adds a frame using the global duration without an override", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frameDurationMs = 40;
    payload.frames[0]!.durationMs = 40;
    const onChange = vi.fn();
    render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("sprite-animation-add-frame"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      frameDurationMs: number;
      frames: Array<{ durationMs: number; durationMsOverride?: boolean }>;
    };
    expect(next.frameDurationMs).toBe(40);
    expect(next.frames).toHaveLength(2);
    expect(next.frames[1]).toMatchObject({ durationMs: 40 });
    expect(next.frames[1]?.durationMsOverride).toBeUndefined();
  });
});
