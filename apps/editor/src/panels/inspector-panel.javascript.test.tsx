import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

const state = vi.hoisted(() => ({ graph: { nodes: [{ id: "js", type: "debug.executeJavaScript", position: { x: 0, y: 0 }, data: {} }], edges: [], members: [] } as SerializedGraph }));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "graph:assets/Test.class.babasset" }) }));
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [{ id: "graph:assets/Test.class.babasset", ref: { kind: "graph", path: "assets/Test.class.babasset", label: "Test" }, content: state.graph, layout: null, dirty: false }],
    applyGraphChange: async (_id: string, graph: SerializedGraph) => { state.graph = graph; return true; },
    projectDocument: { settings: { input: { actions: [], axes: [] } } },
    assetRegistry: { list: () => [] },
  }),
}));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ focusDiagnostic: null, setFocusDiagnostic: vi.fn() }) }));
vi.mock("../context/play-context", () => ({ usePlay: () => ({ focusedNodeId: null }) }));
afterEach(cleanup);

describe("Execute JavaScript Inspector", () => {
  it("adds inputs and outputs and persists object, array and map types", async () => {
    const host = () => <PrefabEditingProvider initialSelectedId={null}><GraphEditingProvider initialSelectedNodeIds={["js"]}><InspectorPanel {...({} as IDockviewPanelProps)} /></GraphEditingProvider></PrefabEditingProvider>;
    const view = render(host());
    fireEvent.change(screen.getByTestId("js-input-add-name"), { target: { value: "items" } });
    fireEvent.click(screen.getByTestId("js-input-add"));
    view.rerender(host());
    const inputs = () => state.graph.nodes[0]!.data.inputs as Array<{ id: string; name: string; type: unknown }>;
    const id = inputs()[0]!.id;
    fireEvent.click(screen.getByTestId(`js-input-${id}-type`));
    fireEvent.click(await screen.findByTestId("search-item-object"));
    view.rerender(host());
    fireEvent.click(screen.getByTestId(`js-input-row-${id}`));
    fireEvent.click(screen.getByRole("button", { name: "Array" }));
    expect(inputs()[0]).toMatchObject({ name: "items", type: { kind: "array", element: { kind: "objectRef", classId: "BObject" } } });
    view.rerender(host());
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(inputs()[0]).toMatchObject({ name: "items", type: { kind: "map", key: { kind: "string" }, value: { kind: "objectRef", classId: "BObject" } } });
    view.rerender(host());
    fireEvent.change(screen.getByTestId("js-output-add-name"), { target: { value: "result" } });
    fireEvent.click(screen.getByTestId("js-output-add"));
    expect(state.graph.nodes[0]!.data.outputs).toEqual([expect.objectContaining({ name: "result", type: { kind: "float" } })]);
  });
});
