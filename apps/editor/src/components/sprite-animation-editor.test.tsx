import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSpriteAnimationPayload } from "@babylonslate/assets";
import {
  SpriteAnimationDetails,
  SpriteAnimationPreview,
} from "./sprite-animation-editor";

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
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        frames: [
          expect.objectContaining({ textureGuid: "tex-1" }),
        ],
      }),
    );
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
