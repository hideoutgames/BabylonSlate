import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createMeshComponent } from "@babylonslate/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyGraphChange = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Hero.class.babasset",
          label: "Hero Class",
        },
        content: {
          nodes: [],
          edges: [],
          members: [
            { id: "var-1", kind: "variable", name: "Health", typeId: "bool" },
          ],
          components: [
            createMeshComponent("prefab-mesh", "box"),
            createMeshComponent("prefab-sphere", "sphere"),
          ],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    projectDocument: {
      settings: {
        twoD: { sortingLayers: ["Default"] },
        input: { actions: [], axes: [] },
      },
    },
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

function renderInspector(options?: {
  selectedComponentId?: string | null;
  selectedComponentIds?: string[];
  selectedMemberId?: string | null;
}) {
  return render(
    <PrefabEditingProvider
      initialSelectedId={options?.selectedComponentId ?? PREFAB_ROOT_ID}
      initialSelectedIds={options?.selectedComponentIds}
    >
      <GraphEditingProvider
        initialSelectedMemberId={options?.selectedMemberId ?? null}
      >
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("Inspector prefab component details", () => {
  it("shows Mesh Kind when a prefab component is selected", () => {
    renderInspector({ selectedComponentId: "prefab-mesh" });
    expect(screen.getByTestId("inspector-prefab-component")).toBeTruthy();
    expect(
      screen.getByTestId("property-prefab-root-prefab-mesh-meshKind"),
    ).toBeTruthy();
  });

  it("shows Position Rotation and Scale for the selected prefab component", () => {
    renderInspector({ selectedComponentId: "prefab-mesh" });
    expect(screen.getByTestId("property-vector3-prefab-mesh-position")).toBeTruthy();
    expect(screen.getByTestId("property-vector3-prefab-mesh-rotation")).toBeTruthy();
    expect(screen.getByTestId("property-vector3-prefab-mesh-scale")).toBeTruthy();
  });

  it("keeps class member details when Prefab Root is selected", () => {
    renderInspector({
      selectedComponentId: PREFAB_ROOT_ID,
      selectedMemberId: "var-1",
    });
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
    expect(screen.queryByTestId("inspector-prefab-component")).toBeNull();
  });

  it("describes Prefab Origin when Prefab Root is selected without a member", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-prefab-origin")).toBeTruthy();
  });

  it("titles Inspector with the component count when more than one is selected", () => {
    renderInspector({
      selectedComponentIds: ["prefab-mesh", "prefab-sphere"],
    });
    expect(screen.getByTestId("inspector-prefab-multi").textContent).toBe(
      "2 Components",
    );
    expect(screen.queryByTestId("inspector-prefab-component")).toBeNull();
    expect(screen.queryByTestId("inspector-prefab-origin")).toBeNull();
  });
});
