import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { encodeTriangleGlb } from "@babylonslate/render";
import { ModelEditor, ModelPreview } from "./model-editor";

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => null,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "mat-1", name: "HeroMat", type: "Material" },
          path: "assets/HeroMat.material.babasset",
        },
        {
          header: { guid: "mat-2", name: "AltMat", type: "Material" },
          path: "assets/AltMat.material.babasset",
        },
        {
          header: { guid: "tex-1", name: "Albedo", type: "Texture" },
          path: "assets/Albedo.texture.babasset",
        },
      ],
    },
    collectPlayMaterialLibrary: async () => ({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [],
    }),
    collectPlayTextureBytes: async () => new Map(),
  }),
}));

afterEach(() => {
  cleanup();
});

describe("ModelEditor", () => {
  it("exposes named Material slot pickers and omits count fields", () => {
    render(
      <ModelEditor
        payload={{
          materialSlots: [
            { index: 0, name: "Hero Mat", materialGuid: "mat-1" },
          ],
          clipNames: ["Walk"],
          materialCount: 1,
          textureCount: 2,
          animationCount: 1,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("model-editor")).toBeTruthy();
    expect(screen.getByTestId("property-row-slot-0").textContent).toContain(
      "Hero Mat",
    );
    expect(screen.getByTestId("property-slot-0").textContent).toContain(
      "HeroMat",
    );
    expect(screen.getByTestId("property-slot-0").textContent).not.toContain(
      "mat-1",
    );
    expect(screen.getByTestId("property-clip-0")).toHaveProperty(
      "disabled",
      true,
    );
    expect((screen.getByTestId("property-clip-0") as HTMLInputElement).value).toBe(
      "Walk",
    );
    expect(screen.queryByTestId("property-materialCount")).toBeNull();
    expect(screen.queryByTestId("property-textureCount")).toBeNull();
    expect(screen.queryByTestId("property-animationCount")).toBeNull();
  });

  it("writes null when a slot is cleared to None", async () => {
    const onChange = vi.fn();
    render(
      <ModelEditor
        payload={{
          materialSlots: [
            { index: 0, name: "Hero Mat", materialGuid: "mat-1" },
          ],
          clipNames: [],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("property-slot-0"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-mat-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-__none__"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        materialSlots: [
          expect.objectContaining({
            index: 0,
            name: "Hero Mat",
            materialGuid: null,
          }),
        ],
      }),
    );
  });

  it("shows Default when a slot has no Material", () => {
    render(
      <ModelEditor
        payload={{
          materialSlots: [{ index: 0, name: "Slot 1", materialGuid: null }],
          clipNames: [],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("property-slot-0").textContent).toContain(
      "Default",
    );
  });
});

describe("ModelPreview", () => {
  it("shows Empty copy when the source is not a loadable glTF mesh", () => {
    render(<ModelPreview payload={{ materialSlots: [], clipNames: [] }} />);
    expect(screen.getByTestId("model-preview")).toBeTruthy();
    expect(screen.getByText("No Mesh")).toBeTruthy();
  });

  it("renders a 1fps preview canvas for glTF source bytes", () => {
    render(
      <ModelPreview
        payload={{ materialSlots: [], clipNames: [] }}
        sourceBytes={encodeTriangleGlb()}
      />,
    );
    expect(screen.getByTestId("model-preview-canvas")).toBeTruthy();
    expect(screen.queryByText("No Mesh")).toBeNull();
  });
});
