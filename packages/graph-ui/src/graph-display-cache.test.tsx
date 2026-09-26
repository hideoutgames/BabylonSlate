import { act, cleanup, render } from "@testing-library/react";
import { useStoreApi } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument, SerializedPin } from "./graph-types";
import * as wildcardDisplay from "./wildcard-display";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function typedGraph(): GraphDocument {
  const pin = (
    id: string,
    direction: SerializedPin["direction"],
    type: SerializedPin["type"],
  ): SerializedPin => ({ id, name: id, kind: "data", direction, type });
  return {
    nodes: [
      {
        id: "source",
        type: "test.source",
        position: { x: 0, y: 0 },
        data: {
          __pins: [
            pin("out", "out", { kind: "array", element: { kind: "float" } }),
          ],
        },
      },
      {
        id: "get",
        type: "test.get",
        position: { x: 300, y: 0 },
        data: {
          __pins: [
            pin("array", "in", {
              kind: "array",
              element: { kind: "resolvingWildcard" },
            }),
            pin("out", "out", { kind: "resolvingWildcard" }),
          ],
        },
      },
      {
        id: "sink",
        type: "test.sink",
        position: { x: 600, y: 0 },
        data: { __pins: [pin("value", "in", { kind: "boxedWildcard" })] },
      },
    ],
    edges: [
      {
        id: "feed",
        source: "source",
        sourceHandle: "out",
        target: "get",
        targetHandle: "array",
      },
      {
        id: "result",
        source: "get",
        sourceHandle: "out",
        target: "sink",
        targetHandle: "value",
      },
    ],
  };
}

function renderGraph(
  initialGraph: GraphDocument,
  commitPositionsOnDragEnd = true,
) {
  let store!: ReturnType<typeof useStoreApi>;
  const onChange = vi.fn();
  function StoreProbe() {
    store = useStoreApi();
    return null;
  }
  const editor = (graph: GraphDocument) => (
    <GraphEditor
      initialGraph={graph}
      commitPositionsOnDragEnd={commitPositionsOnDragEnd}
      onChange={onChange}
      toolbarExtra={<StoreProbe />}
    />
  );
  const view = render(editor(initialGraph));
  return {
    ...view,
    onChange,
    state: () => store.getState(),
    setGraph: (graph: GraphDocument) => view.rerender(editor(graph)),
    sinkColor: () =>
      view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="sink"] [data-handleid="value"] .graph-pin-visual',
      )?.style.background,
  };
}

describe("GraphEditor display caching", () => {
  it.each([false, true])(
    "reuses pin resolution and styled edges during dragging (deferred commits: %s)",
    (deferred) => {
      const solve = vi.spyOn(wildcardDisplay, "displayPinTypesForGraph");
      const graph = renderGraph(typedGraph(), deferred);
      expect(graph.sinkColor()).toBe("var(--pin-float)");
      const edges = graph.state().edges;
      const solves = solve.mock.calls.length;
      expect(solves).toBeGreaterThan(0);

      act(() =>
        graph.state().onNodesChange!([
          { id: "source", type: "select", selected: true },
          {
            id: "source",
            type: "dimensions",
            dimensions: { width: 100, height: 80 },
          },
        ]),
      );
      for (const x of [10, 20, 30]) {
        act(() =>
          graph.state().onNodesChange!([
            {
              id: "source",
              type: "position",
              position: { x, y: 40 },
              dragging: true,
            },
          ]),
        );
      }
      act(() =>
        graph.state().onNodesChange!([
          {
            id: "source",
            type: "position",
            position: { x: 30, y: 40 },
            dragging: false,
          },
        ]),
      );

      expect(
        graph.state().nodes.find((node) => node.id === "source")?.position,
      ).toEqual({ x: 30, y: 40 });
      expect(graph.onChange.mock.calls.at(-1)?.[0].nodes[0].position).toEqual({
        x: 30,
        y: 40,
      });
      expect(solve.mock.calls.length).toBe(solves);
      // Stable input to XYFlow avoids rebuilding every wire while nodes move.
      expect(graph.state().edges).toBe(edges);
      expect(graph.sinkColor()).toBe("var(--pin-float)");
    },
  );

  it("refreshes inferred colors for external pin edits, disconnects, and undo", () => {
    const original = typedGraph();
    const graph = renderGraph(original);
    const edited = structuredClone(original);
    (edited.nodes[0].data.__pins as SerializedPin[])[0].type = {
      kind: "array",
      element: { kind: "string" },
    };
    graph.setGraph(edited);
    expect(graph.sinkColor()).toBe("var(--pin-string)");
    expect(
      graph.state().edges.find((edge) => edge.id === "result")?.style?.stroke,
    ).toBe("var(--pin-string)");

    graph.setGraph({ ...edited, edges: [edited.edges[1]] });
    expect(graph.sinkColor()).toBe("var(--pin-wildcard)");
    expect(graph.state().edges[0].style?.stroke).toBe("var(--pin-wildcard)");

    graph.setGraph(original);
    expect(graph.sinkColor()).toBe("var(--pin-float)");
    expect(
      graph.state().edges.find((edge) => edge.id === "result")?.style?.stroke,
    ).toBe("var(--pin-float)");
    expect(graph.onChange).not.toHaveBeenCalled();
    expect((original.nodes[1].data.__pins as SerializedPin[])[1].type).toEqual({
      kind: "resolvingWildcard",
    });
  });

  it("keeps edge selection live when pin topology is unchanged", () => {
    const graph = renderGraph(typedGraph());
    act(() =>
      graph.state().onEdgesChange!([
        { id: "result", type: "select", selected: true },
      ]),
    );
    expect(
      graph.state().edges.find((edge) => edge.id === "result"),
    ).toMatchObject({
      selected: true,
      style: { stroke: "var(--pin-float)", strokeWidth: 4 },
    });
    expect(graph.onChange).not.toHaveBeenCalled();
  });
});
