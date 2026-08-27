import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { encodeTriangleGlb } from "@babylonslate/render";
import { ModelColliderSessionProvider } from "../context/model-collider-session";
import { ModelColliders, ModelEditor, ModelPreview } from "./model-editor";

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
    expect(screen.queryByTestId("model-preview-shading")).toBeNull();
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

  it("overlays session PBR / Unlit / Wireframe shading on the glTF canvas", () => {
    render(
      <ModelPreview
        payload={{ materialSlots: [], clipNames: [] }}
        sourceBytes={encodeTriangleGlb()}
      />,
    );
    expect(screen.getByTestId("model-preview-shading")).toBeTruthy();
    expect(
      screen.getByTestId("model-preview-shading-pbr").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("model-preview-shading-unlit")).toBeTruthy();
    expect(screen.getByTestId("model-preview-shading-wireframe")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-preview-shading-unlit"));
    expect(
      screen.getByTestId("model-preview-shading-unlit").getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("model-preview-shading-wireframe"));
    expect(
      screen
        .getByTestId("model-preview-shading-wireframe")
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("toggles Show Collision on the glTF preview toolbar", () => {
    render(
      <ModelColliderSessionProvider>
        <ModelPreview
          payload={{ materialSlots: [], clipNames: [] }}
          sourceBytes={encodeTriangleGlb()}
        />
      </ModelColliderSessionProvider>,
    );
    const toggle = screen.getByTestId("model-show-collision");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

function ColliderHarness({
  sourceBytes,
}: {
  sourceBytes?: Uint8Array | null;
}) {
  const [payload, setPayload] = useState<Record<string, unknown>>({
    materialSlots: [],
    clipNames: [],
  });
  return (
    <ModelColliderSessionProvider>
      <ModelColliders
        payload={payload}
        sourceBytes={sourceBytes}
        onChange={setPayload}
      />
      <ModelPreview payload={payload} sourceBytes={sourceBytes ?? undefined} />
    </ModelColliderSessionProvider>
  );
}

describe("ModelColliders", () => {
  it("adds a Box from the Add menu and deletes the selected row", () => {
    render(<ColliderHarness />);
    expect(screen.getByTestId("model-colliders")).toBeTruthy();
    expect(screen.getByText("No Colliders")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-add-collider"));
    fireEvent.click(screen.getByTestId("model-add-collider-box"));
    expect(screen.getByTestId("model-collider-tree").textContent).toContain("Box");
    expect(screen.getByTestId("property-row-halfExtents")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-delete-collider"));
    expect(screen.getByText("No Colliders")).toBeTruthy();
  });

  it("shows Move Rotate Scale tools after a collider is selected", () => {
    render(<ColliderHarness sourceBytes={encodeTriangleGlb()} />);
    fireEvent.click(screen.getByTestId("model-add-collider"));
    fireEvent.click(screen.getByTestId("model-add-collider-box"));
    expect(screen.getByTestId("model-collider-gizmo-tools")).toBeTruthy();
    expect(screen.getByTestId("model-collider-gizmo-translate")).toBeTruthy();
    expect(screen.getByTestId("model-collider-gizmo-rotate")).toBeTruthy();
    expect(screen.getByTestId("model-collider-gizmo-scale")).toBeTruthy();
  });

  it("cooks Generated Collision from the open Model source chunk", () => {
    render(<ColliderHarness sourceBytes={encodeTriangleGlb()} />);
    fireEvent.click(screen.getByTestId("model-add-collider"));
    fireEvent.click(screen.getByTestId("model-add-collider-generated"));
    expect(screen.getByTestId("model-collider-tree").textContent).toContain(
      "Generated Collision",
    );
  });
});
