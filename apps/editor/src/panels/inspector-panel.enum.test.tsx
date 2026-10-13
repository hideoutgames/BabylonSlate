import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

const state = vi.hoisted(() => ({ graph: { nodes: [], edges: [] } as SerializedGraph }));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "graph:assets/Test.class.babasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "graph:assets/Test.class.babasset", ref: { kind: "graph", path: "assets/Test.class.babasset", label: "Test" }, content: state.graph, layout: null, dirty: false }],
  projectDocument: { settings: {} },
  assetRegistry: { list: () => [] },
})));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ focusDiagnostic: null, setFocusDiagnostic: vi.fn() }) }));
vi.mock("../context/play-context", () => ({ usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null }));
afterEach(cleanup);

describe("Enum node Inspector", () => {
  it("locks Enum Type from the wire in the open function graph, not the Event Graph", () => {
    const make = { id: "make", type: "enum.make", position: { x: 0, y: 0 }, data: { enumGuid: "enum-team" } };
    const sw = { id: "sw", type: "enum.switch", position: { x: 200, y: 0 }, data: {} };
    state.graph = {
      nodes: [sw], edges: [], members: [{ id: "fn", kind: "function", name: "Run" }],
      functionGraphs: {
        fn: {
          nodes: [make, sw],
          edges: [{ id: "e", source: "make", sourceHandle: "out", target: "sw", targetHandle: "value" }],
        },
      },
    } as SerializedGraph;
    const host = (functionId?: string) => (
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider initialSelectedNodeIds={["sw"]} initialActiveFunctionId={functionId}>
          <InspectorPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </PrefabEditingProvider>
    );
    render(host("fn"));
    expect(screen.getByTestId("property-enumGuid")).toHaveProperty("disabled", true);
    cleanup();
    render(host());
    expect(screen.getByTestId("property-enumGuid")).toHaveProperty("disabled", false);
  });
});
