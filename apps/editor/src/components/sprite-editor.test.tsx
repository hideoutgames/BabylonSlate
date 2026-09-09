import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { SpriteEditor, SpritePreview } from "./sprite-editor";

const readAssetChunk = vi.hoisted(() =>
  vi.fn<() => Promise<Uint8Array | null>>(async () => null),
);

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    readAssetChunk,
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
  readAssetChunk.mockReset();
});

describe("SpriteEditor", () => {
  it("retries an unreadable texture without reopening the document", async () => {
    readAssetChunk.mockResolvedValueOnce(null).mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-texture");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const { container } = render(<SpritePreview payload={{ ...createDefaultSpritePayload(), textureGuid: "tex-1" } as unknown as Record<string, unknown>} />);
      expect(await screen.findByText("Texture Preview Failed")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:recovered-texture"));
      expect(screen.queryByText("Texture Preview Failed")).toBeNull();
    } finally {
      cleanup();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
  it("identifies a missing texture rather than asking the author to keep waiting", () => {
    render(<SpritePreview payload={{ ...createDefaultSpritePayload(), textureGuid: "missing" } as unknown as Record<string, unknown>} />);
    expect(screen.getByText("Missing Texture")).toBeTruthy();
    expect(screen.queryByText(/Loading texture/i)).toBeNull();
  });
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

  it("shows the Texture asset display name instead of the guid", () => {
    const payload = {
      ...createDefaultSpritePayload(),
      textureGuid: "tex-1",
    };
    render(
      <SpriteEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("property-texture").textContent).toContain(
      "HeroAtlas",
    );
    expect(screen.getByTestId("property-texture").textContent).not.toContain(
      "tex-1",
    );
  });

  it("does not show a leftover Clip Name field", () => {
    render(
      <SpriteEditor
        payload={createDefaultSpritePayload() as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("property-clip-name")).toBeNull();
  });

  it("renders a sprite preview with a pivot marker", () => {
    render(
      <SpritePreview
        payload={createDefaultSpritePayload() as unknown as Record<string, unknown>}
      />,
    );
    expect(screen.getByTestId("sprite-preview")).toBeTruthy();
    expect(screen.getByTestId("sprite-pivot-marker")).toBeTruthy();
    expect(screen.getByTestId("sprite-collision-overlay")).toBeTruthy();
  });
});
