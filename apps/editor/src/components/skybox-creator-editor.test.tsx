import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSkyboxCreatorPayload } from "@babylonslate/assets";
import {
  SkyboxCreatorEditor,
  SkyboxCreatorPreview,
} from "./skybox-creator-editor";

const createAsset = vi.fn();
const deleteAsset = vi.fn();
const refreshAssetRegistry = vi.fn();
const readAssetChunk = vi.fn(async () => Uint8Array.of(1, 2, 3));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "Sky", type: "Texture" },
          path: "assets/Sky.babasset",
          rootId: "project",
        },
        {
          header: { guid: "face-px", name: "Day_px", type: "Texture" },
          path: "assets/Old_px.babasset",
          rootId: "project",
        },
      ],
      getRoot: () => ({ id: "project", pathPrefix: "assets" }),
      createAsset,
      deleteAsset,
    },
    openDocuments: [],
    readAssetChunk,
    refreshAssetRegistry,
  }),
}));

vi.mock("@babylonslate/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/assets")>();
  return {
    ...actual,
    decodeSourceToRgba: async () => {
      const rgba = new Uint8Array(4 * 3 * 4);
      return { rgba, width: 4, height: 3, clamped: false };
    },
  };
});

vi.mock("@babylonslate/render", () => ({
  encodePngRgba: () => Uint8Array.of(9),
  createMaterialPreviewScene: () => null,
  createMaterialPreviewPresenter: () => null,
  createSkyboxMeshForFaces: () => null,
  ResourceCache: class {},
}));

afterEach(() => {
  cleanup();
  createAsset.mockReset();
  deleteAsset.mockReset();
  refreshAssetRegistry.mockReset();
});

describe("SkyboxCreatorEditor", () => {
  it("lets the author pick a Texture", async () => {
    const payload = createDefaultSkyboxCreatorPayload();
    const onChange = vi.fn();
    render(
      <SkyboxCreatorEditor
        payload={payload as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.babasset"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("skybox-creator-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-source"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-tex-1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTextureGuid: "tex-1" }),
    );
  });

  it("shows an alert when Create runs without a source Texture", async () => {
    render(
      <SkyboxCreatorEditor
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.babasset"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(screen.getByTestId("skybox-creator-alert")).toBeTruthy();
    });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("writes six skybox Textures from the picked source", async () => {
    const payload = {
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
    };
    const onChange = vi.fn();
    render(
      <SkyboxCreatorEditor
        payload={payload as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.babasset"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(createAsset).toHaveBeenCalledTimes(6);
    });
    expect(createAsset.mock.calls.map((call) => call[1])).toEqual([
      "Day_px.babasset",
      "Day_py.babasset",
      "Day_pz.babasset",
      "Day_nx.babasset",
      "Day_ny.babasset",
      "Day_nz.babasset",
    ]);
    expect(refreshAssetRegistry).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTextureGuid: "tex-1",
        generatedFaces: expect.objectContaining({
          px: expect.any(String),
        }),
      }),
    );
  });
});

describe("SkyboxCreatorPreview", () => {
  it("shows the template net labels and empty state without a Texture", () => {
    render(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    expect(screen.getByTestId("skybox-creator-preview")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-net")).toBeTruthy();
    expect(screen.getByText("FRONT")).toBeTruthy();
    expect(screen.getByText("BACK")).toBeTruthy();
    expect(screen.getByText("LEFT")).toBeTruthy();
    expect(screen.getByText("RIGHT")).toBeTruthy();
    expect(screen.getByText("UP")).toBeTruthy();
    expect(screen.getByText("DOWN")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-empty")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-create")).toBeTruthy();
  });
});
