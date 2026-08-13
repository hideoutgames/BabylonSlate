import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { SpriteEditor } from "./sprite-editor";

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

describe("SpriteEditor", () => {
  it("lets the author pick a Texture asset", async () => {
    const payload = createDefaultSpritePayload();
    const onChange = vi.fn();
    render(
      <SpriteEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("sprite-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-texture"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-tex-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-mesh-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ textureGuid: "tex-1" }),
    );
  });
});
