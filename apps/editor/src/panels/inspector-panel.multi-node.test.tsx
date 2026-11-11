import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@haptic/core";
import { FLOAT, INT, STRING, pin } from "@haptic/scripting";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, next: SerializedGraph) => Promise<boolean>>(async () => true),
);

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "graph:assets/Hero.class.hasset" }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "graph:assets/Hero.class.hasset",
      ref: { kind: "graph", path: "assets/Hero.class.hasset", label: "Hero Class" },
      content: {
        nodes: [
          {
            id: "add-1",
            type: "math.add",
            position: { x: 0, y: 0 },
            data: {
              title: "Add",
              __pins: [pin("a", "A", "in", FLOAT), pin("b", "B", "in", FLOAT)],
              "default:a": 1,
              "default:b": 2,
            },
          },
          {
            id: "multiply-1",
            type: "math.multiply",
            position: { x: 0, y: 100 },
            data: {
              title: "Multiply",
              __pins: [pin("a", "A", "in", FLOAT), pin("b", "B", "in", FLOAT), pin("c", "C", "in", FLOAT)],
              "default:a": 3,
              "default:b": 2,
            },
          },
          {
            id: "count-1",
            type: "math.addInt",
            position: { x: 0, y: 200 },
            data: {
              title: "Add Int",
              __pins: [pin("a", "A", "in", INT)],
              "default:a": 1,
            },
          },
          {
            id: "log-1",
            type: "debug.log",
            position: { x: 0, y: 300 },
            data: {
              title: "Log",
              __pins: [pin("message", "Message", "in", STRING)],
              severity: "warning",
            },
          },
        ],
        edges: [],
        members: [],
      },
      layout: null,
      dirty: false,
    },
  ],
  applyGraphChange,
  projectDocument: { settings: {} },
})));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ focusDiagnostic: null, setFocusDiagnostic: vi.fn() }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null,
}));

function renderInspector(selectedNodeIds: string[]) {
  return render(
    <PrefabEditingProvider initialSelectedId={null}>
      <GraphEditingProvider initialSelectedNodeIds={selectedNodeIds}>
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

/** Each node's data in the one graph change the edit persisted. */
function persistedNodeData() {
  expect(applyGraphChange).toHaveBeenCalledTimes(1);
  const next = applyGraphChange.mock.calls[0]![1];
  return Object.fromEntries(next.nodes.map((node) => [node.id, node.data]));
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("Inspector multi-node selection", () => {
  it("shows the pin Defaults an Add and a Multiply share, Mixed Values where they differ, and hides a pin only one has", () => {
    renderInspector(["add-1", "multiply-1"]);
    expect(screen.getByTestId("inspector-multi-node").textContent).toContain("2 Nodes");
    const a = screen.getByTestId("property-a") as HTMLInputElement;
    expect(a.value).toBe("Mixed Values");
    expect((screen.getByTestId("property-b") as HTMLInputElement).value).toBe("2");
    expect(screen.queryByTestId("property-c")).toBeNull();
  });

  it("hides a same-id pin of another type", () => {
    renderInspector(["add-1", "count-1"]);
    expect(screen.getByTestId("inspector-multi-node")).toBeTruthy();
    expect(screen.queryByTestId("property-a")).toBeNull();
    expect(screen.queryByTestId("inspector-pin-defaults")).toBeNull();
  });

  it("hides a section only one node type has and keeps one every node has", () => {
    renderInspector(["log-1", "add-1"]);
    expect(screen.queryByTestId("inspector-log-properties")).toBeNull();
    expect(screen.getByTestId("property-developmentOnly")).toBeTruthy();
  });

  it("sets a shared value on every selected node in one graph change", () => {
    renderInspector(["add-1", "multiply-1"]);
    fireEvent.change(screen.getByTestId("property-b"), { target: { value: "5" } });
    const data = persistedNodeData();
    expect(data["add-1"]!["default:b"]).toBe(5);
    expect(data["multiply-1"]!["default:b"]).toBe(5);
    expect(data["add-1"]!["default:a"]).toBe(1);
    expect(data["multiply-1"]!["default:a"]).toBe(3);
  });

  it("adds to each node's own value when Mixed Values+4 is typed", () => {
    renderInspector(["add-1", "multiply-1"]);
    const a = screen.getByTestId("property-a");
    fireEvent.focus(a);
    fireEvent.change(a, { target: { value: "Mixed Values+4" } });
    const data = persistedNodeData();
    expect(data["add-1"]!["default:a"]).toBe(5);
    expect(data["multiply-1"]!["default:a"]).toBe(7);
  });

  it("keeps a single selected node's own sections", () => {
    renderInspector(["log-1"]);
    expect(screen.queryByTestId("inspector-multi-node")).toBeNull();
    expect(screen.getByTestId("inspector-log-properties")).toBeTruthy();
  });
});
