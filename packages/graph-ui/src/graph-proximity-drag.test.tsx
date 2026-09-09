import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Position, useStoreApi, type Node } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphEditor, type GraphEditorProps } from "./graph-editor";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(cleanup);

const floatOutput: SerializedPin = {
  id: "value",
  name: "Value",
  kind: "data",
  direction: "out",
  type: { kind: "float" },
};
const floatInput: SerializedPin = {
  ...floatOutput,
  id: "input",
  name: "Input",
  direction: "in",
};

function graphWithFreePins(): GraphDocument {
  return {
    nodes: [
      {
        id: "source",
        type: "test.source",
        position: { x: 0, y: 0 },
        data: { title: "Source", __pins: [floatOutput] },
      },
      {
        id: "target",
        type: "test.target",
        position: { x: 260, y: 0 },
        data: { title: "Target", __pins: [floatInput] },
      },
    ],
    edges: [],
  };
}

type MeasuredPin = Pick<SerializedPin, "id" | "direction"> & {
  side?: Position;
};

function renderDragGraph(
  graph = graphWithFreePins(),
  props: Partial<GraphEditorProps> = {},
) {
  let store!: ReturnType<typeof useStoreApi>;
  let currentProps = props;
  const emitted: GraphDocument[] = [];
  const measurements = new Map<string, MeasuredPin[]>();

  function StoreProbe() {
    store = useStoreApi();
    return null;
  }

  function editor() {
    return (
      <GraphEditor
        commitPositionsOnDragEnd
        sessionViewport={{ x: 0, y: 0, zoom: 1 }}
        {...currentProps}
        initialGraph={graph}
        onChange={(next) => emitted.push(next)}
        toolbarExtra={<StoreProbe />}
      />
    );
  }

  const view = render(editor());

  // jsdom has no layout. Supply only the handle measurements that XYFlow
  // normally reads from the real rendered nodes; keep its store and callbacks.
  function measureHandles() {
    const state = store.getState();
    for (const node of state.nodes) {
      const internal = state.nodeLookup.get(node.id)!;
      const pins: readonly MeasuredPin[] =
        measurements.get(node.id) ??
        (node.data.__pins as SerializedPin[] | undefined) ??
        [];
      function handles(direction: "out" | "in") {
        return pins
          .filter((pin) => pin.direction === direction)
          .map((pin, row) => {
            const side =
              pin.side ??
              (direction === "out" ? Position.Right : Position.Left);
            return {
              id: pin.id,
              nodeId: node.id,
              type:
                direction === "out" ? ("source" as const) : ("target" as const),
              position: side,
              x: side === Position.Right ? 94 : -6,
              y: 26 + row * 32,
              width: 12,
              height: 12,
            };
          });
      }
      internal.measured = { width: 100, height: 160 };
      internal.internals.handleBounds = {
        source: handles("out"),
        target: handles("in"),
      };
    }
  }

  function sourceAt(position?: Node["position"]): Node {
    const source = store.getState().nodes.find((node) => node.id === "source")!;
    return { ...source, position: position ?? source.position };
  }

  measureHandles();
  return {
    ...view,
    emitted,
    previews: () =>
      view.container.querySelectorAll<SVGPathElement>(
        ".graph-proximity-preview",
      ),
    setGraph(next: GraphDocument) {
      graph = next;
      view.rerender(editor());
    },
    setProps(next: Partial<GraphEditorProps>) {
      currentProps = { ...currentProps, ...next };
      view.rerender(editor());
    },
    setMeasurements(nodeId: string, pins: MeasuredPin[]) {
      measurements.set(nodeId, pins);
      measureHandles();
    },
    start() {
      const node = sourceAt();
      act(() => {
        store.getState().onNodeDragStart!(new MouseEvent("mousedown"), node, [
          node,
        ]);
      });
    },
    move(position = { x: 130, y: 0 }) {
      act(() => {
        store.getState().onNodesChange!([
          { id: "source", type: "position", position, dragging: true },
        ]);
      });
      measureHandles();
      const node = sourceAt(position);
      act(() => {
        store.getState().onNodeDrag!(new MouseEvent("mousemove"), node, [node]);
      });
    },
    stop(position?: Node["position"]) {
      measureHandles();
      const node = sourceAt(position);
      act(() => {
        store.getState().onNodeDragStop!(new MouseEvent("mouseup"), node, [
          node,
        ]);
      });
    },
  };
}

describe("GraphEditor proximity dragging", () => {
  it("keeps discovering nearby pins after the host refreshes a drag that started out of range", () => {
    const graph = renderDragGraph(undefined, { commitPositionsOnDragEnd: false });
    graph.start();
    graph.move({ x: 10, y: 0 });
    const earlierPosition = graph.emitted.at(-1)!;
    graph.move({ x: 20, y: 0 });
    expect(graph.previews()).toHaveLength(0);

    // A host render can arrive after the pointer has already advanced again.
    graph.setGraph(earlierPosition);
    graph.move();
    expect(graph.previews()).toHaveLength(1);
    graph.stop();
    expect(graph.emitted.at(-1)?.edges).toHaveLength(1);
  });

  it("requires a fresh preview after a host refresh before connecting on release", () => {
    const graph = renderDragGraph();
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(1);

    const refreshed = graphWithFreePins();
    refreshed.nodes[0]!.position = { x: 130, y: 0 };
    refreshed.nodes[1]!.data.title = "Refreshed Target";
    graph.setGraph(refreshed);
    expect(graph.previews()).toHaveLength(0);
    graph.stop();
    expect(graph.emitted).toEqual([]);
  });

  it("previews without saving, clears when moving away, and commits the final position on release", () => {
    const graph = renderDragGraph(undefined, {
      defaultEdgeOptions: { type: "smoothstep" },
    });
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(1);
    expect(graph.previews()[0]?.style.opacity).toBe("0.5");
    expect(graph.previews()[0]?.style.pointerEvents).toBe("none");
    expect(graph.emitted).toEqual([]);

    graph.move({ x: 0, y: 0 });
    expect(graph.previews()).toHaveLength(0);
    expect(graph.emitted).toEqual([]);

    graph.move();
    graph.stop({ x: 140, y: 10 });
    expect(graph.previews()).toHaveLength(0);
    expect(graph.emitted).toHaveLength(1);
    expect(graph.emitted[0]?.edges).toEqual([
      {
        id: "e:source:value:target:input",
        source: "source",
        sourceHandle: "value",
        target: "target",
        targetHandle: "input",
        type: "smoothstep",
      },
    ]);
    expect(
      graph.emitted[0]?.nodes.find((node) => node.id === "source")?.position,
    ).toEqual({ x: 140, y: 10 });
    expect(
      graph.emitted[0]?.nodes.find((node) => node.id === "target")?.position,
    ).toEqual({ x: 260, y: 0 });
  });

  it.each(["Escape", "pointercancel", "secondTouch"])(
    "%s cancels suggestions for the rest of the gesture",
    (event) => {
      const graph = renderDragGraph();
      graph.start();
      graph.move();
      expect(graph.previews()).toHaveLength(1);
      if (event === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else if (event === "secondTouch") {
        fireEvent.touchStart(document, {
          touches: [{ identifier: 1 }, { identifier: 2 }],
        });
      } else {
        fireEvent(document, new Event("pointercancel", { bubbles: true }));
      }
      expect(graph.previews()).toHaveLength(0);
      graph.move();
      graph.stop();
      expect(graph.previews()).toHaveLength(0);
      expect(graph.emitted).toEqual([]);

      graph.start();
      graph.move();
      expect(graph.previews()).toHaveLength(1);
    },
  );

  it.each([{ readOnly: true }, { nodesDraggable: false }])(
    "cancels an active preview when editing is disabled by %j",
    (props) => {
      const graph = renderDragGraph();
      graph.start();
      graph.move();
      expect(graph.previews()).toHaveLength(1);
      graph.setProps(props);
      expect(graph.previews()).toHaveLength(0);
      graph.stop();
      graph.start();
      graph.move();
      graph.stop();
      expect(graph.previews()).toHaveLength(0);
      expect(graph.emitted).toEqual([]);
    },
  );

  it("rechecks the host veto on release", () => {
    let allowed = true;
    const graph = renderDragGraph(undefined, { canConnect: () => allowed });
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(1);
    allowed = false;
    graph.stop();
    expect(graph.previews()).toHaveLength(0);
    expect(graph.emitted).toEqual([]);
  });

  it("skips disabled nodes even when their handles remain measured", () => {
    const document = graphWithFreePins();
    document.nodes[1]!.data.__disabled = true;
    const graph = renderDragGraph(document);
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(0);
    graph.stop();
    expect(graph.emitted).toEqual([]);
  });

  it("previews and saves only mutually compatible wildcard connections", () => {
    const document = graphWithFreePins();
    document.nodes[0]!.data.__pins = [
      { ...floatOutput, id: "number" },
      { ...floatOutput, id: "text", type: { kind: "string" } },
    ];
    document.nodes[1]!.data.__pins = [
      { ...floatInput, id: "a", type: { kind: "resolvingWildcard" } },
      { ...floatInput, id: "b", type: { kind: "resolvingWildcard" } },
    ];
    const graph = renderDragGraph(document);
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(1);
    graph.stop();
    expect(graph.emitted).toHaveLength(1);
    expect(graph.emitted[0]?.edges).toEqual([
      {
        id: "e:source:number:target:a",
        source: "source",
        sourceHandle: "number",
        target: "target",
        targetHandle: "a",
        type: "default",
      },
    ]);
    const target = graph.emitted[0]?.nodes.find((node) => node.id === "target");
    expect(target?.data.__pins).toEqual([
      { ...floatInput, id: "a", type: { kind: "resolvingWildcard" } },
      { ...floatInput, id: "b", type: { kind: "resolvingWildcard" } },
    ]);
  });

  it("ignores stale measured handles with no corresponding pin metadata", () => {
    const document = graphWithFreePins();
    delete document.nodes[0]!.data.__pins;
    const graph = renderDragGraph(document, { canConnect: () => false });
    graph.setMeasurements("source", [floatOutput]);
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(0);
    graph.stop();
    expect(graph.emitted).toEqual([]);
  });

  it("leaves overlapping input/output state plates to their own gestures", () => {
    const document = graphWithFreePins();
    document.nodes[0]!.data.__pins = [floatOutput, floatInput];
    const graph = renderDragGraph(document);
    graph.setMeasurements("source", [
      { ...floatOutput, side: Position.Right },
      { ...floatInput, side: Position.Right },
    ]);
    graph.start();
    graph.move();
    expect(graph.previews()).toHaveLength(0);
    graph.stop();
    expect(graph.emitted).toEqual([]);
  });
});
