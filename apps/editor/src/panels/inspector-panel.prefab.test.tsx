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
          components: [createMeshComponent("prefab-mesh", "box")],
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
  selectedMemberId?: string | null;
}) {
  return render(
    <PrefabEditingProvider
      initialSelectedId={options?.selectedComponentId ?? PREFAB_ROOT_ID}
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

  it("keeps class member details when Prefab Root is selected", () => {
    renderInspector({
      selectedComponentId: PREFAB_ROOT_ID,
      selectedMemberId: "var-1",
    });
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
    expect(screen.queryByTestId("inspector-prefab-component")).toBeNull();
  });
});
