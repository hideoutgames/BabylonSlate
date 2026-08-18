import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSpriteAnimationPayload } from "@babylonslate/assets";
import {
  SpriteAnimationDetails,
  SpriteAnimationPreview,
} from "./sprite-animation-editor";

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
  });
});
