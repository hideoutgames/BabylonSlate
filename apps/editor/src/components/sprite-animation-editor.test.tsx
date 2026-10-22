import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let assetRegistry: AssetRegistry;

beforeAll(async () => {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("animation-preview.hproject");
  assetRegistry = new AssetRegistry(storage);
  await assetRegistry.mountRoot(projectContentRoot());
  for (const asset of [
    { guid: "tex-1", name: "HeroAtlas", type: "Texture" },
    { guid: "tex-2", name: "HeroRun", type: "Texture" },
    { guid: "mesh-1", name: "Cube", type: "Mesh" },
  ]) {
    await assetRegistry.createAsset(
      "project",
      `${asset.name}.${asset.type.toLowerCase()}.hasset`,
      { ...asset, version: 1, dependencies: [], payload: {}, chunks: [] },
    );
  }
});

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry,
  readAssetChunk,
})));

afterEach(() => {
  cleanup();
  readAssetChunk.mockClear();
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
  it("lets the author pick a Texture for the current frame", async () => {
    const payload = createDefaultSpriteAnimationPayload();
    const onChange = vi.fn();
    render(
      <SpriteAnimationDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("sprite-animation-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-texture"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-tex-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-mesh-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          frames: [
            expect.objectContaining({
              textureGuid: "tex-1",
              width: 200,
              height: 100,
            }),
          ],
        }),
      );
    });
  });

  it("applies a picked Texture to the animation as edited while the image loads", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    readAssetChunk.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const payload = createDefaultSpriteAnimationPayload();
    const onChange = vi.fn();
    const view = render(
      <SpriteAnimationDetails payload={payload as unknown as Record<string, unknown>} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("property-texture"));
    fireEvent.click(await screen.findByTestId("search-item-tex-1"));
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalled());
    const edited = { ...payload, frameDurationMs: 250 };
    view.rerender(
      <SpriteAnimationDetails payload={edited as unknown as Record<string, unknown>} onChange={onChange} />,
    );
    await act(async () => finishRead(pngIhdr(200, 100)));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frameDurationMs: 250,
        frames: [expect.objectContaining({ textureGuid: "tex-1", width: 200, height: 100 })],
      }),
    );
  });

  it("keeps a frame's pending Texture pick when another frame's Texture is picked", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    readAssetChunk.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const onChange = vi.fn();
    function Harness() {
      const [payload, setPayload] = useState<Record<string, unknown>>(
        () => createDefaultSpriteAnimationPayload() as unknown as Record<string, unknown>,
      );
      return (
        <SpriteAnimationDetails
          payload={payload}
          onChange={(next) => {
            setPayload(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId("property-texture"));
    fireEvent.click(await screen.findByTestId("search-item-tex-1"));
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("sprite-animation-add-frame"));
    expect(screen.getByTestId("sprite-animation-selected-frame").textContent).toBe("Frame 2");
    fireEvent.click(screen.getByTestId("property-texture"));
    fireEvent.click(await screen.findByTestId("search-item-tex-2"));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          frames: [expect.anything(), expect.objectContaining({ textureGuid: "tex-2" })],
        }),
      ),
    );
    await act(async () => finishRead(pngIhdr(64, 32)));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frames: [
          expect.objectContaining({ textureGuid: "tex-1", width: 64, height: 32 }),
          expect.objectContaining({ textureGuid: "tex-2", width: 200, height: 100 }),
        ],
      }),
    );
  });

  it("plays indexed frame textures without scanning the registry and stops on pause", async () => {
    const listAssets = vi.spyOn(assetRegistry, "list");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:animation-texture");
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
    await waitFor(() => {
      expect(preview.querySelectorAll("img")).toHaveLength(3);
    });
    expect(readAssetChunk).toHaveBeenCalledWith("assets/HeroAtlas.texture.hasset", "pixels");
    expect(readAssetChunk).toHaveBeenCalledWith("assets/HeroRun.texture.hasset", "pixels");
    readAssetChunk.mockClear();

    fireEvent.click(screen.getByTestId("sprite-animation-play"));
    expect(preview.getAttribute("data-playing")).toBe("true");
    act(() => {
      flush(25);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("0");
    expect(readAssetChunk).not.toHaveBeenCalled();
    await act(async () => {
      flush(125);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("1");
    expect(preview.querySelectorAll("img")).toHaveLength(3);
    expect(readAssetChunk).toHaveBeenCalledTimes(1);
    expect(readAssetChunk).toHaveBeenCalledWith("assets/HeroRun.texture.hasset", "pixels");

    fireEvent.click(screen.getByTestId("sprite-animation-pause"));
    expect(preview.getAttribute("data-playing")).toBe("false");
    act(() => {
      flush(200);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("1");
    expect(listAssets).not.toHaveBeenCalled();
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
