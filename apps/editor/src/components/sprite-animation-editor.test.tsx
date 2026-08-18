import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSpriteAnimationPayload } from "@babylonslate/assets";
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

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "HeroAtlas", type: "Texture" },
          path: "assets/HeroAtlas.texture.babasset",
        },
        {
          header: { guid: "mesh-1", name: "Cube", type: "Mesh" },
          path: "assets/Cube.mesh.babasset",
        },
      ],
    },
    readAssetChunk,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SpriteAnimation editor", () => {
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

  it("positions pivot and collision on the object-contain image box", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frames[0]!.width = 200;
    payload.frames[0]!.height = 100;
    render(
      <SpriteAnimationPreview
        payload={payload as unknown as Record<string, unknown>}
      />,
    );
    const box = screen.getByTestId("sprite-animation-image-box");
    expect(box.style.left).toBe("0%");
    expect(box.style.top).toBe("25%");
    expect(box.style.width).toBe("100%");
    expect(box.style.height).toBe("50%");
    expect(box.querySelector("[data-testid='sprite-pivot-marker']")).toBeTruthy();
    expect(box.querySelector("[data-testid='sprite-collision-overlay']")).toBeTruthy();
  });

  it("renders preview pivot, collision overlay, and a frame strip", () => {
    render(
      <SpriteAnimationPreview
        payload={createDefaultSpriteAnimationPayload() as unknown as Record<string, unknown>}
      />,
    );
    expect(screen.getByTestId("sprite-animation-preview")).toBeTruthy();
    expect(screen.getByTestId("sprite-pivot-marker")).toBeTruthy();
    expect(screen.getByTestId("sprite-collision-overlay")).toBeTruthy();
    expect(screen.getByTestId("sprite-animation-frame-0")).toBeTruthy();
    expect(screen.getByTestId("sprite-animation-play")).toBeTruthy();
    expect(screen.getByTestId("sprite-animation-loop").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("advances the current frame while playing and stops on pause", () => {
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
    const preview = screen.getByTestId("sprite-animation-preview");
    expect(preview.getAttribute("data-playing")).toBe("false");
    expect(preview.getAttribute("data-frame-index")).toBe("0");

    fireEvent.click(screen.getByTestId("sprite-animation-play"));
    expect(preview.getAttribute("data-playing")).toBe("true");
    act(() => {
      flush(150);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("1");

    fireEvent.click(screen.getByTestId("sprite-animation-pause"));
    expect(preview.getAttribute("data-playing")).toBe("false");
    act(() => {
      flush(200);
    });
    expect(preview.getAttribute("data-frame-index")).toBe("1");
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

  it("edits Frame Duration MS on the animation payload", () => {
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
    );
  });

  it("hides per-frame duration until Frame Duration MS Override is on and seeds the global value", () => {
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
