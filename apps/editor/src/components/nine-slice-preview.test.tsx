import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NineSliceMarginOverlay, NineSlicePreview } from "./nine-slice-preview";

const docs = vi.hoisted(() => ({
  loadAssetDocument: vi.fn(async () => null as unknown),
  readAssetChunk: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
  assets: [
    {
      header: { guid: "tex-1", name: "Panel", type: "Texture" },
      path: "assets/Panel.texture.babasset",
    },
    {
      header: { guid: "mat-1", name: "PanelMat", type: "Material" },
      path: "assets/PanelMat.material.babasset",
    },
  ],
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => docs.assets },
    readAssetChunk: docs.readAssetChunk,
    loadAssetDocument: docs.loadAssetDocument,
  }),
}));

afterEach(() => {
  cleanup();
  docs.loadAssetDocument.mockReset();
  docs.readAssetChunk.mockClear();
  vi.restoreAllMocks();
});

describe("NineSliceMarginOverlay", () => {
  it("places dashed lines and orange dots from source fractions", () => {
    render(
      <NineSliceMarginOverlay
        left={0.1}
        right={0.8}
        top={0.2}
        bottom={0.7}
      />,
    );
    expect(screen.getByTestId("panel-nine-slice-line-left").style.left).toBe(
      "10%",
    );
    expect(screen.getByTestId("panel-nine-slice-line-right").style.left).toBe(
      "80%",
    );
    expect(screen.getByTestId("panel-nine-slice-line-top").style.top).toBe("20%");
    expect(screen.getByTestId("panel-nine-slice-line-bottom").style.top).toBe(
      "70%",
    );
    const nw = screen.getByTestId("panel-nine-slice-dot-nw");
    expect(nw.style.left).toBe("10%");
    expect(nw.style.top).toBe("20%");
    const se = screen.getByTestId("panel-nine-slice-dot-se");
    expect(se.style.left).toBe("80%");
    expect(se.style.top).toBe("70%");
  });
});

describe("NineSlicePreview", () => {
  it("hides the overlay when no texture or material is assigned", () => {
    render(
      <NineSlicePreview
        source="texture"
        textureGuid={null}
        materialGuid={null}
        marginLeft={10}
        marginRight={10}
        marginTop={10}
        marginBottom={10}
      />,
    );
    expect(screen.getByTestId("panel-nine-slice-preview")).toBeTruthy();
    expect(screen.queryByTestId("panel-nine-slice-overlay")).toBeNull();
  });

  it("loads a texture still and maps pixel margins onto the contain box", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:panel");
    render(
      <NineSlicePreview
        source="texture"
        textureGuid="tex-1"
        materialGuid={null}
        marginLeft={10}
        marginRight={20}
        marginTop={5}
        marginBottom={15}
        sourceWidthPx={100}
        sourceHeightPx={50}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("panel-nine-slice-overlay")).toBeTruthy();
    });
    expect(docs.readAssetChunk).toHaveBeenCalledWith(
      "assets/Panel.texture.babasset",
      "pixels",
    );
    expect(screen.getByTestId("panel-nine-slice-line-left").style.left).toBe(
      "10%",
    );
    expect(screen.getByTestId("panel-nine-slice-line-right").style.left).toBe(
      "80%",
    );
    expect(screen.getByTestId("panel-nine-slice-line-top").style.top).toBe("10%");
    expect(screen.getByTestId("panel-nine-slice-line-bottom").style.top).toBe(
      "70%",
    );
    const contain = screen.getByTestId("panel-nine-slice-image-box");
    expect(contain.style.top).toBe("25%");
    expect(contain.style.height).toBe("50%");
  });

  it("uses the first sampled texture on a material as the still frame", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mat-panel");
    docs.loadAssetDocument.mockResolvedValue({
      nodes: [
        {
          type: "texture.sample",
          properties: { textureGuid: "tex-1" },
        },
      ],
    });
    render(
      <NineSlicePreview
        source="material"
        textureGuid={null}
        materialGuid="mat-1"
        marginLeft={10}
        marginRight={10}
        marginTop={10}
        marginBottom={10}
        sourceWidthPx={100}
        sourceHeightPx={100}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("panel-nine-slice-overlay")).toBeTruthy();
    });
    expect(docs.loadAssetDocument).toHaveBeenCalledWith(
      "material",
      "assets/PanelMat.material.babasset",
    );
    expect(docs.readAssetChunk).toHaveBeenCalledWith(
      "assets/Panel.texture.babasset",
      "pixels",
    );
  });
});
