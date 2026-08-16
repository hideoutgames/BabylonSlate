import { act, fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import { DRAG_ARM_MS } from "@babylonslate/editor-kit";
import { GRAPH_MIN_ZOOM, GraphEditor } from "./graph-editor";
import type { GraphDocument } from "./graph-types";
import { FORMAT_GAP_X } from "./graph-format";
import { MARQUEE_FALLBACK_WIDTH } from "./graph-marquee";
import { treeNodeTypes } from "./tree-node";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX?: number; clientY?: number; pointerId?: number } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  target.dispatchEvent(event);
}

const debugLogPins = [
  {
    id: "execIn",
    name: "exec",
    kind: "exec" as const,
    direction: "in" as const,
    type: { kind: "exec" },
  },
  {
    id: "execOut",
    name: "then",
    kind: "exec" as const,
    direction: "out" as const,
    type: { kind: "exec" },
  },
  {
    id: "message",
    name: "message",
    kind: "data" as const,
    direction: "in" as const,
    type: { kind: "string" },
  },
];

function graphWithPins(): GraphDocument {
  return {
    nodes: [
      {
        id: "log-a",
        type: "debug.log",
        position: { x: 0, y: 0 },
        data: { message: "A", __pins: debugLogPins },
      },
      {
        id: "log-b",
        type: "debug.log",
        position: { x: 280, y: 0 },
        data: { message: "B", __pins: debugLogPins },
      },
    ],
    edges: [],
  };
}

function graphWithWiredPins(): GraphDocument {
  const graph = graphWithPins();
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: "log-c",
        type: "debug.log",
        position: { x: 560, y: 0 },
        data: { message: "C", __pins: debugLogPins },
      },
    ],
    edges: [
      {
        id: "e:log-a:execOut:log-b:execIn",
        source: "log-a",
        target: "log-b",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
      {
        id: "e:log-a:execOut:log-c:execIn",
        source: "log-a",
        target: "log-c",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
    ],
  };
}

function stubMeasuredGraphLayout(): () => void {
  const previousWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  const previousHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 180;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 80;
    },
  });

  class ImmediateResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            contentRect: {
              x: 0,
              y: 0,
              width: 180,
              height: 80,
              top: 0,
              left: 0,
              bottom: 80,
              right: 180,
              toJSON() {
                return {};
              },
            },
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;

  const previousFromPoint = Document.prototype.elementFromPoint;
  Document.prototype.elementFromPoint = () => null;

  return () => {
    if (previousWidth) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", previousWidth);
    }
    if (previousHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        previousHeight,
      );
    }
    globalThis.ResizeObserver = previousObserver;
    Document.prototype.elementFromPoint = previousFromPoint;
  };
}

function mockHandleRect(handle: Element, rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): void {
  Object.defineProperty(handle, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON() {
        return {};
      },
    }),
  });
}

function dragHandle(
  handle: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  during?: () => void,
): void {
  fireEvent.mouseDown(handle, {
    clientX: from.x,
    clientY: from.y,
    button: 0,
  });
  fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
  dispatchPointerEvent(document.body, "pointermove", {
    clientX: to.x,
    clientY: to.y,
    pointerId: 1,
  });
  during?.();
  fireEvent.mouseUp(document, { clientX: to.x, clientY: to.y });
}

function openPalette(container: HTMLElement) {
  const pane = container.querySelector(".react-flow__pane");
  expect(pane).not.toBeNull();
  fireEvent.click(pane!);
  fireEvent.click(pane!);
}

const farDrop = { x: 500, y: 22 };

const pinDragPalette = [
  {
    id: "debug.log",
    title: "Log",
    category: "Debug",
    pins: debugLogPins,
  },
  {
    id: "math.add",
    title: "Add",
    category: "Math",
    pins: [
      {
        id: "a",
        name: "a",
        kind: "data" as const,
        direction: "in" as const,
        type: { kind: "float" },
      },
      {
        id: "b",
        name: "b",
        kind: "data" as const,
        direction: "in" as const,
        type: { kind: "float" },
      },
      {
        id: "out",
        name: "out",
        kind: "data" as const,
        direction: "out" as const,
        type: { kind: "float" },
      },
    ],
  },
];

function mockPinDragLayout(container: HTMLElement): Element {
  container.querySelectorAll(".react-flow__node").forEach((node, index) => {
    mockHandleRect(node, {
      left: index * 280,
      top: 0,
      width: 180,
      height: 80,
    });
  });
  const source = container.querySelector(
    '[data-id="log-a"] [data-handleid="execOut"][data-handlepos="right"]',
  );
  expect(source).not.toBeNull();
  mockHandleRect(source!, { left: 0, top: 0, width: 44, height: 44 });
  const other = container.querySelector(
    '[data-id="log-b"] [data-handleid="execIn"][data-handlepos="left"]',
  );
  if (other) {
    mockHandleRect(other, { left: 280, top: 0, width: 44, height: 44 });
  }
  return source!;
}

describe("GraphEditor", () => {
  it("lets authors zoom the canvas out to 10 percent", () => {
    expect(GRAPH_MIN_ZOOM).toBeLessThan(0.4);
    expect(GRAPH_MIN_ZOOM).toBe(0.1);
  });

  it("renders a node for each node in the graph", () => {
    const graph = createDefaultGraph();
    const { container } = render(<GraphEditor initialGraph={graph} />);

    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(
      container.querySelectorAll(".react-flow__node").length,
    ).toBe(graph.nodes.length);
  });

  it("renders the log message body so authors can read it on the canvas", () => {
    const graph = createDefaultGraph();
    const message = String(graph.nodes[0]?.data.message ?? "");
    const { getByText } = render(<GraphEditor initialGraph={graph} />);

    expect(getByText("Log Message")).toBeTruthy();
    expect(getByText(message)).toBeTruthy();
  });

  it("renders an empty canvas without nodes", () => {
    const { container } = render(
      <GraphEditor initialGraph={{ nodes: [], edges: [] }} />,
    );
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("renders pin handles when node data includes __pins", () => {
    const { container } = render(<GraphEditor initialGraph={graphWithPins()} />);
    expect(container.querySelectorAll(".react-flow__handle")).not.toHaveLength(0);
  });

  it("creates an edge when tapping an output pin then an input pin", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GraphEditor initialGraph={graphWithPins()} onChange={onChange} />,
    );

    const nodeElements = container.querySelectorAll(".react-flow__node");
    expect(nodeElements.length).toBe(2);

    const source = nodeElements[0]?.querySelector(
      '[data-handleid="execOut"][data-handlepos="right"]',
    );
    const target = nodeElements[1]?.querySelector(
      '[data-handleid="execIn"][data-handlepos="left"]',
    );
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    fireEvent.click(source!);
    fireEvent.click(target!);

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toHaveLength(1);
    expect(lastGraph.edges[0]).toMatchObject({
      source: "log-a",
      target: "log-b",
      sourceHandle: "execOut",
      targetHandle: "execIn",
    });
  });

  it("adds a tap-to-connect edge without stripping existing wires", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [
        ...graphWithPins().nodes,
        {
          id: "log-c",
          type: "debug.log",
          position: { x: 560, y: 0 },
          data: { message: "C", __pins: debugLogPins },
        },
      ],
      edges: [
        {
          id: "e:log-a:execOut:log-b:execIn",
          source: "log-a",
          target: "log-b",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const { container } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );

    const source = container.querySelector(
      '[data-id="log-a"] [data-handleid="execOut"][data-handlepos="right"]',
    );
    const target = container.querySelector(
      '[data-id="log-c"] [data-handleid="execIn"][data-handlepos="left"]',
    );
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    fireEvent.click(source!);
    fireEvent.click(target!);

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "log-a",
          target: "log-b",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
        expect.objectContaining({
          source: "log-a",
          target: "log-c",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
      ]),
    );
    expect(lastGraph.edges).toHaveLength(2);
  });

  it("keeps a second exec wire into the same exec input", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [
        ...graphWithPins().nodes,
        {
          id: "log-c",
          type: "debug.log",
          position: { x: 560, y: 0 },
          data: { message: "C", __pins: debugLogPins },
        },
      ],
      edges: [
        {
          id: "e:log-a:execOut:log-c:execIn",
          source: "log-a",
          target: "log-c",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const { container } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );

    const source = container.querySelector(
      '[data-id="log-b"] [data-handleid="execOut"][data-handlepos="right"]',
    );
    const target = container.querySelector(
      '[data-id="log-c"] [data-handleid="execIn"][data-handlepos="left"]',
    );
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    fireEvent.click(source!);
    fireEvent.click(target!);

    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toHaveLength(2);
    expect(lastGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "log-a",
          target: "log-c",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
        expect.objectContaining({
          source: "log-b",
          target: "log-c",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
      ]),
    );
  });

  it("replaces an existing data wire when connecting a second source to the same input", () => {
    const onChange = vi.fn();
    const stringOutPins = [
      {
        id: "value",
        name: "value",
        kind: "data" as const,
        direction: "out" as const,
        type: { kind: "string" },
      },
    ];
    const graph: GraphDocument = {
      nodes: [
        {
          id: "get-a",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: { __pins: stringOutPins },
        },
        {
          id: "get-b",
          type: "variables.get",
          position: { x: 0, y: 120 },
          data: { __pins: stringOutPins },
        },
        {
          id: "log-b",
          type: "debug.log",
          position: { x: 280, y: 0 },
          data: { message: "B", __pins: debugLogPins },
        },
      ],
      edges: [
        {
          id: "e:get-a:value:log-b:message",
          source: "get-a",
          target: "log-b",
          sourceHandle: "value",
          targetHandle: "message",
        },
      ],
    };
    const { container } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );

    const source = container.querySelector(
      '[data-id="get-b"] [data-handleid="value"][data-handlepos="right"]',
    );
    const target = container.querySelector(
      '[data-id="log-b"] [data-handleid="message"][data-handlepos="left"]',
    );
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    fireEvent.click(source!);
    fireEvent.click(target!);

    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toEqual([
      expect.objectContaining({
        source: "get-b",
        target: "log-b",
        sourceHandle: "value",
        targetHandle: "message",
      }),
    ]);
  });

  it("breaks all wires on a pin when a drag is released without connecting", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container } = render(
        <GraphEditor initialGraph={graphWithWiredPins()} onChange={onChange} />,
      );

      const source = container.querySelector(
        '[data-id="log-a"] [data-handleid="execOut"][data-handlepos="right"]',
      );
      expect(source).not.toBeNull();
      mockHandleRect(source!, { left: 0, top: 0, width: 44, height: 44 });
      onChange.mockClear();

      act(() => {
        dragHandle(source!, { x: 22, y: 22 }, { x: 80, y: 22 });
      });

      expect(onChange).toHaveBeenCalled();
      const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
      expect(lastGraph.edges).toEqual([]);
    } finally {
      restoreLayout();
    }
  });

  it("does not break wires when the drag is released on the source handle", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container } = render(
        <GraphEditor initialGraph={graphWithWiredPins()} onChange={onChange} />,
      );

      const source = container.querySelector(
        '[data-id="log-a"] [data-handleid="execOut"][data-handlepos="right"]',
      );
      expect(source).not.toBeNull();
      mockHandleRect(source!, { left: 0, top: 0, width: 44, height: 44 });
      onChange.mockClear();

      act(() => {
        dragHandle(source!, { x: 22, y: 22 }, { x: 30, y: 22 });
      });

      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it("does not open Add Node when a pin drag is released in empty canvas", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const { container, queryByTestId } = render(
        <GraphEditor
          initialGraph={graphWithPins()}
          paletteNodes={pinDragPalette}
        />,
      );
      const source = mockPinDragLayout(container);
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, farDrop);
      });
      expect(queryByTestId("node-palette-body")).toBeNull();
    } finally {
      restoreLayout();
    }
  });

  it("does not break wires when a far pin drag is released without a second pointer", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container } = render(
        <GraphEditor
          initialGraph={graphWithWiredPins()}
          paletteNodes={pinDragPalette}
          onChange={onChange}
        />,
      );
      const source = mockPinDragLayout(container);
      onChange.mockClear();
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, farDrop);
      });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it("does not open Add Node when a second pointer lands in the source safe zone", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const { container, queryByTestId } = render(
        <GraphEditor
          initialGraph={graphWithPins()}
          paletteNodes={pinDragPalette}
        />,
      );
      const source = mockPinDragLayout(container);
      const pane = container.querySelector(".react-flow__pane");
      expect(pane).not.toBeNull();
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, { x: 40, y: 22 }, () => {
          dispatchPointerEvent(pane!, "pointerdown", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
          dispatchPointerEvent(pane!, "pointerup", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
        });
      });
      expect(queryByTestId("node-palette-body")).toBeNull();
    } finally {
      restoreLayout();
    }
  });

  it("opens a pin-filtered Add Node menu on a second pointer during a far pin drag", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const { container, getByTestId, queryByTestId } = render(
        <GraphEditor
          initialGraph={graphWithPins()}
          paletteNodes={pinDragPalette}
        />,
      );
      const source = mockPinDragLayout(container);
      const pane = container.querySelector(".react-flow__pane");
      expect(pane).not.toBeNull();
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, farDrop, () => {
          dispatchPointerEvent(pane!, "pointerdown", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
          dispatchPointerEvent(pane!, "pointerup", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
        });
      });
      expect(getByTestId("node-palette-body")).toBeTruthy();
      expect(getByTestId("node-palette-item-debug.log")).toBeTruthy();
      expect(queryByTestId("node-palette-item-math.add")).toBeNull();
    } finally {
      restoreLayout();
    }
  });

  it("keeps Add Node open after the drag pointer is released", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container, getByTestId } = render(
        <GraphEditor
          initialGraph={graphWithWiredPins()}
          paletteNodes={pinDragPalette}
          onChange={onChange}
        />,
      );
      const source = mockPinDragLayout(container);
      const pane = container.querySelector(".react-flow__pane");
      expect(pane).not.toBeNull();
      onChange.mockClear();
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, farDrop, () => {
          dispatchPointerEvent(pane!, "pointerdown", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
          dispatchPointerEvent(pane!, "pointerup", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
        });
      });
      expect(getByTestId("node-palette-body")).toBeTruthy();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it("spawns a picked node at the drag point and auto-connects the dragged pin", () => {
    const restoreLayout = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container, getByTestId } = render(
        <GraphEditor
          initialGraph={graphWithPins()}
          paletteNodes={pinDragPalette}
          onChange={onChange}
        />,
      );
      const source = mockPinDragLayout(container);
      const pane = container.querySelector(".react-flow__pane");
      expect(pane).not.toBeNull();
      act(() => {
        dragHandle(source, { x: 22, y: 22 }, farDrop, () => {
          dispatchPointerEvent(pane!, "pointerdown", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
          dispatchPointerEvent(pane!, "pointerup", {
            clientX: 400,
            clientY: 100,
            pointerId: 2,
          });
        });
      });
      fireEvent.click(getByTestId("node-palette-item-debug.log"));
      expect(onChange).toHaveBeenCalled();
      const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
      const added = lastGraph.nodes.find((node) => node.id !== "log-a" && node.id !== "log-b");
      expect(added).toBeDefined();
      expect(added?.position.x).not.toBe(0);
      expect(
        lastGraph.edges.some(
          (edge) =>
            edge.source === "log-a" &&
            edge.sourceHandle === "execOut" &&
            edge.target === added?.id &&
            edge.targetHandle === "execIn",
        ),
      ).toBe(true);
    } finally {
      restoreLayout();
    }
  });

  it("shows an error badge on nodes referenced by diagnostics", () => {
    const graph = createDefaultGraph();
    const nodeId = graph.nodes[0]?.id ?? "";
    const { getByLabelText } = render(
      <GraphEditor
        initialGraph={graph}
        diagnostics={[
          {
            nodeId,
            severity: "error",
            message: "Type mismatch",
          },
        ]}
      />,
    );

    expect(getByLabelText("1 error")).toBeTruthy();
  });

  it("clips the title bar to the shell radius without clipping the error badge", () => {
    const graph = createDefaultGraph();
    const nodeId = graph.nodes[0]?.id ?? "";
    const { getByText, getByLabelText, container } = render(
      <GraphEditor
        initialGraph={graph}
        diagnostics={[
          {
            nodeId,
            severity: "error",
            message: "Type mismatch",
          },
        ]}
      />,
    );

    const shell = container.querySelector("[data-node-role]");
    expect(shell?.className).toMatch(/\boverflow-hidden\b/);
    expect(shell?.className).toMatch(/\brounded-lg\b/);

    const title = getByText("Log Message");
    expect(title.className).toMatch(/\brounded-t-lg\b/);

    const badge = getByLabelText("1 error");
    expect(shell?.contains(badge)).toBe(false);
  });

  it("opens the node palette and adds a node from paletteNodes", () => {
    const onChange = vi.fn();
    const { getByText, container } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[
          { id: "debug.log", title: "Log", category: "Debug" },
        ]}
        onChange={onChange}
      />,
    );

    openPalette(container);
    fireEvent.click(getByText("Log"));

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes).toHaveLength(1);
    expect(lastGraph.nodes[0]?.type).toBe("debug.log");
    expect(lastGraph.nodes[0]?.data.title).toBe("Log");
  });

  it("does not autofocus palette search on open", () => {
    const { getByPlaceholderText, getByTestId, container } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[{ id: "debug.log", title: "Log", category: "Debug" }]}
      />,
    );

    openPalette(container);
    const search = getByPlaceholderText("Search nodes");
    expect(search.getAttribute("data-autofocus-search")).toBeNull();
    expect(document.activeElement).not.toBe(search);
    expect(getByTestId("node-palette-body")).toBeTruthy();
  });

  it("embeds palette pins into added nodes so handles appear", () => {
    const onChange = vi.fn();
    const { getByText, container } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[
          {
            id: "debug.log",
            title: "Log",
            category: "Debug",
            pins: debugLogPins,
            defaultData: { message: "", severity: "log", category: "Script" },
          },
        ]}
        onChange={onChange}
      />,
    );

    openPalette(container);
    fireEvent.click(getByText("Log"));

    expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(
      0,
    );
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes[0]?.data.__pins).toEqual(debugLogPins);
    expect(lastGraph.nodes[0]?.data.message).toBe("");
  });

  it("stamps __editorOnly when adding an editor-only palette node", () => {
    const onChange = vi.fn();
    const { getByText, container } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[
          {
            id: "flow.sequence",
            title: "Sequence",
            category: "Flow",
            editorOnly: true,
          },
        ]}
        onChange={onChange}
      />,
    );

    openPalette(container);
    fireEvent.click(getByText("Sequence"));

    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes[0]?.data.__editorOnly).toBe(true);
  });

  it("renders Blueprint chrome with type-colored pins and wide exec wires", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {
            title: "Event Begin Play",
            __nodeType: "flow.event.beginPlay",
            __category: "flow",
            __pure: true,
            __pins: [
              {
                id: "execOut",
                name: "then",
                kind: "exec",
                direction: "out",
                type: { kind: "exec" },
              },
            ],
          },
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 280, y: 0 },
          data: {
            title: "Log",
            __nodeType: "debug.log",
            __category: "debug",
            __pins: debugLogPins,
          },
        },
      ],
      edges: [
        {
          id: "e:begin:execOut:log:execIn",
          source: "begin",
          target: "log",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };

    const { container } = render(<GraphEditor initialGraph={graph} />);
    const eventNode = container.querySelector('[data-node-role="event"]');
    expect(eventNode).not.toBeNull();

    const execHandle = container.querySelector(
      '[data-handleid="execOut"][data-pin-type="exec"]',
    );
    expect(execHandle).not.toBeNull();
    expect(execHandle?.className).toMatch(/min-h-11|size-11/);

    const messageHandle = container.querySelector(
      '[data-handleid="message"][data-pin-type="string"]',
    );
    expect(messageHandle).not.toBeNull();
  });

  it("marks unwired pin visuals as disconnected", () => {
    const { container } = render(<GraphEditor initialGraph={graphWithPins()} />);
    const visuals = container.querySelectorAll("[data-pin-connected]");
    expect(visuals.length).toBeGreaterThan(0);
    for (const visual of visuals) {
      expect(visual.getAttribute("data-pin-connected")).toBe("false");
    }
  });

  it("marks wired exec pins connected and leaves unused pins on the same node hollow", () => {
    const { container } = render(
      <GraphEditor initialGraph={graphWithWiredPins()} />,
    );

    const execOut = container.querySelector(
      '[data-id="log-a"] [data-handleid="execOut"] [data-pin-connected]',
    );
    const execInB = container.querySelector(
      '[data-id="log-b"] [data-handleid="execIn"] [data-pin-connected]',
    );
    const messageA = container.querySelector(
      '[data-id="log-a"] [data-handleid="message"] [data-pin-connected]',
    );
    const execOutB = container.querySelector(
      '[data-id="log-b"] [data-handleid="execOut"] [data-pin-connected]',
    );

    expect(execOut?.getAttribute("data-pin-connected")).toBe("true");
    expect(execInB?.getAttribute("data-pin-connected")).toBe("true");
    expect(messageA?.getAttribute("data-pin-connected")).toBe("false");
    expect(execOutB?.getAttribute("data-pin-connected")).toBe("false");
  });

  it("shows a read-only bool default between an empty pin and its name", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "branch",
          type: "flow.branch",
          position: { x: 0, y: 0 },
          data: {
            title: "Branch",
            __nodeType: "flow.branch",
            "default:condition": true,
            __pins: [
              {
                id: "execIn",
                name: "exec",
                kind: "exec",
                direction: "in",
                type: { kind: "exec" },
              },
              {
                id: "condition",
                name: "condition",
                kind: "data",
                direction: "in",
                type: { kind: "bool" },
              },
              {
                id: "true",
                name: "true",
                kind: "exec",
                direction: "out",
                type: { kind: "exec" },
              },
            ],
          },
        },
      ],
      edges: [],
    };

    const { container } = render(<GraphEditor initialGraph={graph} />);
    const handle = container.querySelector(
      '[data-id="branch"] [data-handleid="condition"]',
    );
    const preview = container.querySelector(
      '[data-id="branch"] [data-pin-default="bool"]',
    );
    const label = container.querySelector(
      '[data-id="branch"] [data-pin-label="condition"]',
    );
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute("data-checked")).toBe("true");
    expect(label?.className).toMatch(/text-base/);
    expect(handle?.nextElementSibling).toBe(preview);
    expect(preview?.nextElementSibling).toBe(label);
  });

  it("hides the bool default when that pin is wired", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "src",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            __pins: [
              {
                id: "value",
                name: "value",
                kind: "data",
                direction: "out",
                type: { kind: "bool" },
              },
            ],
          },
        },
        {
          id: "branch",
          type: "flow.branch",
          position: { x: 280, y: 0 },
          data: {
            "default:condition": true,
            __pins: [
              {
                id: "condition",
                name: "condition",
                kind: "data",
                direction: "in",
                type: { kind: "bool" },
              },
            ],
          },
        },
      ],
      edges: [
        {
          id: "e:src:value:branch:condition",
          source: "src",
          target: "branch",
          sourceHandle: "value",
          targetHandle: "condition",
        },
      ],
    };

    const { container } = render(<GraphEditor initialGraph={graph} />);
    expect(
      container.querySelector('[data-id="branch"] [data-pin-default="bool"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-id="branch"] [data-pin-label="condition"]'),
    ).not.toBeNull();
  });

  it("shows a tiny capped string field for an unconnected string default", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "log",
          type: "debug.log",
          position: { x: 0, y: 0 },
          data: {
            "default:message": "Hello World",
            __pins: debugLogPins,
          },
        },
      ],
      edges: [],
    };

    const { container } = render(<GraphEditor initialGraph={graph} />);
    const preview = container.querySelector(
      '[data-id="log"] [data-pin-default="string"]',
    );
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe("Hello World");
    expect(preview?.className).toMatch(/--graph-pin-default-max-width/);
    expect(
      container.querySelector('[data-id="log"] [data-pin-default]'),
    ).not.toBe(
      container.querySelector('[data-id="log"] [data-handleid="execIn"]'),
    );
    expect(
      container.querySelector('[data-id="log"] [data-handleid="execIn"]')
        ?.parentElement?.querySelector("[data-pin-default]"),
    ).toBeNull();
  });

  it("sizes outgoing pin names at text-base too", () => {
    const { container } = render(<GraphEditor initialGraph={graphWithPins()} />);
    const thenLabel = container.querySelector(
      '[data-id="log-a"] [data-pin-label="then"]',
    );
    expect(thenLabel?.className).toMatch(/text-base/);
  });

  it("shows a Development Only tape on Print by default", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "print",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            title: "Print",
            __category: "debug",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId } = render(<GraphEditor initialGraph={graph} />);
    const banner = getByTestId("development-only-banner");
    expect(banner.getAttribute("aria-label")).toBe("Development Only");
    expect(banner.textContent?.trim()).toBe("");
  });

  it("hides the Development Only tape when Print opts out", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "print",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            title: "Print",
            developmentOnly: false,
            __category: "debug",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { queryByTestId } = render(<GraphEditor initialGraph={graph} />);
    expect(queryByTestId("development-only-banner")).toBeNull();
  });

  it("does not show a Development Only tape on Log unless flagged", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "log",
          type: "debug.log",
          position: { x: 0, y: 0 },
          data: {
            title: "Log",
            __category: "debug",
            __pins: debugLogPins,
          },
        },
      ],
      edges: [],
    };

    const { queryByTestId } = render(<GraphEditor initialGraph={graph} />);
    expect(queryByTestId("development-only-banner")).toBeNull();
  });

  it("shows a Development Only tape on a flagged non-Print node", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "branch",
          type: "flow.branch",
          position: { x: 0, y: 0 },
          data: {
            title: "Branch",
            developmentOnly: true,
            __category: "flow",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId } = render(<GraphEditor initialGraph={graph} />);
    expect(getByTestId("development-only-banner")).toBeTruthy();
  });

  it("clips the Development Only tape to the shell without clipping the error badge", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "print",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            title: "Print",
            __category: "debug",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId, getByLabelText, container } = render(
      <GraphEditor
        initialGraph={graph}
        diagnostics={[
          {
            nodeId: "print",
            severity: "error",
            message: "Type mismatch",
          },
        ]}
      />,
    );

    const shell = container.querySelector("[data-node-role]");
    const banner = getByTestId("development-only-banner");
    const badge = getByLabelText("1 error");
    expect(shell?.contains(banner)).toBe(true);
    expect(shell?.contains(badge)).toBe(false);
    expect(shell?.className).toMatch(/\boverflow-hidden\b/);
    expect(shell?.className).toMatch(/\brounded-lg\b/);
  });

  it("shows an Editor Only tape when __editorOnly is set", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "sequence",
          type: "flow.sequence",
          position: { x: 0, y: 0 },
          data: {
            title: "Sequence",
            __editorOnly: true,
            __category: "flow",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId, queryByTestId } = render(
      <GraphEditor initialGraph={graph} />,
    );
    const banner = getByTestId("editor-only-banner");
    expect(banner.getAttribute("aria-label")).toBe("Editor Only");
    expect(banner.className).toMatch(/graph-node-editor-only-tape/);
    expect(queryByTestId("development-only-banner")).toBeNull();
  });

  it("does not show an Editor Only tape without __editorOnly", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "log",
          type: "debug.log",
          position: { x: 0, y: 0 },
          data: {
            title: "Log",
            __category: "debug",
            __pins: debugLogPins,
          },
        },
      ],
      edges: [],
    };

    const { queryByTestId } = render(<GraphEditor initialGraph={graph} />);
    expect(queryByTestId("editor-only-banner")).toBeNull();
  });

  it("does not treat Development Only as Editor Only", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "print",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            title: "Print",
            __category: "debug",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId, queryByTestId } = render(
      <GraphEditor initialGraph={graph} />,
    );
    expect(getByTestId("development-only-banner")).toBeTruthy();
    expect(queryByTestId("editor-only-banner")).toBeNull();
  });

  it("shows both tapes when a node is development-only and editor-only", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "print",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            title: "Print",
            __editorOnly: true,
            __category: "debug",
            __pins: [],
          },
        },
      ],
      edges: [],
    };

    const { getByTestId } = render(<GraphEditor initialGraph={graph} />);
    const development = getByTestId("development-only-banner");
    const editor = getByTestId("editor-only-banner");
    expect(development.nextElementSibling).toBe(editor);
  });

  it("renders array pins with a list icon and scalar pins as circles", () => {
    const graph: GraphDocument = {
      nodes: [
        {
          id: "length",
          type: "array.length",
          position: { x: 0, y: 0 },
          data: {
            title: "Array Length",
            __nodeType: "array.length",
            __category: "array",
            __pure: true,
            __pins: [
              {
                id: "array",
                name: "array",
                kind: "data",
                direction: "in",
                type: { kind: "array", element: { kind: "float" } },
              },
              {
                id: "out",
                name: "out",
                kind: "data",
                direction: "out",
                type: { kind: "int" },
              },
            ],
          },
        },
      ],
      edges: [],
    };

    const { container } = render(<GraphEditor initialGraph={graph} />);

    const arrayHandle = container.querySelector('[data-pin-type="array"]');
    expect(arrayHandle).not.toBeNull();
    expect(arrayHandle?.querySelector('[data-pin-shape="list"]')).not.toBeNull();

    const intHandle = container.querySelector('[data-pin-type="int"]');
    expect(intHandle).not.toBeNull();
    expect(intHandle?.querySelector('[data-pin-shape="circle"]')).not.toBeNull();
  });

  it("uses the host colorMode on the canvas", () => {
    const { container } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        colorMode="light"
      />,
    );
    const canvas = container.querySelector(".react-flow");
    expect(canvas?.className).toMatch(/\blight\b/);
  });

  it("defaults to a dark canvas so editor theme does not wash the graph", () => {
    document.documentElement.classList.remove("dark");
    const { container } = render(
      <GraphEditor initialGraph={{ nodes: [], edges: [] }} />,
    );
    expect(container.querySelector(".react-flow")?.className).toMatch(/\bdark\b/);
  });

  it("does not render an Add node button", () => {
    const { queryByRole, getByTestId } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[{ id: "debug.log", title: "Log", category: "Debug" }]}
      />,
    );
    expect(queryByRole("button", { name: "Add node" })).toBeNull();
    expect(getByTestId("graph-toolbar")).toBeTruthy();
    expect(getByTestId("graph-format")).toHaveProperty("disabled", true);
    expect(getByTestId("graph-break-links")).toHaveProperty("disabled", true);
  });

  it("keeps Break Links disabled for an unwired selection", () => {
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graphWithPins()} />,
    );
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="log-a"]')!,
    );
    expect(getByTestId("graph-break-links")).toHaveProperty("disabled", true);
  });

  it("breaks every pin link on a selected node and keeps the nodes", () => {
    const onChange = vi.fn();
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graphWithWiredPins()} onChange={onChange} />,
    );
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="log-a"]')!,
    );
    expect(getByTestId("graph-break-links")).toHaveProperty("disabled", false);
    fireEvent.click(getByTestId("graph-break-links"));

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toEqual([]);
    expect(lastGraph.nodes.map((node) => node.id)).toEqual([
      "log-a",
      "log-b",
      "log-c",
    ]);
  });

  it("breaks only incident wires when a downstream node is selected", () => {
    const onChange = vi.fn();
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graphWithWiredPins()} onChange={onChange} />,
    );
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="log-b"]')!,
    );
    fireEvent.click(getByTestId("graph-break-links"));

    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.edges).toEqual([
      expect.objectContaining({
        source: "log-a",
        target: "log-c",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      }),
    ]);
    expect(lastGraph.nodes).toHaveLength(3);
  });

  it("reports selected node ids when a node is clicked", async () => {
    const onSelectionChange = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        onSelectionChange={onSelectionChange}
        onChange={onChange}
      />,
    );

    const node = container.querySelector('.react-flow__node[data-id="log-a"]');
    expect(node).not.toBeNull();
    fireEvent.click(node!);

    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith(["log-a"]);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports an empty selection when the pane is clicked", async () => {
    const onSelectionChange = vi.fn();
    const { container, rerender } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        focusedNodeId="log-a"
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith(["log-a"]);
    });
    onSelectionChange.mockClear();

    rerender(
      <GraphEditor
        initialGraph={graphWithPins()}
        onSelectionChange={onSelectionChange}
      />,
    );

    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);

    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith([]);
    });
  });

  it("recolors a boxed wildcard pin when a concrete type is wired in", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [
        {
          id: "src",
          type: "math.const",
          position: { x: 0, y: 0 },
          data: {
            title: "Float",
            __pins: [
              {
                id: "out",
                name: "out",
                kind: "data",
                direction: "out",
                type: { kind: "float" },
              },
            ],
          },
        },
        {
          id: "print",
          type: "debug.print",
          position: { x: 280, y: 0 },
          data: {
            title: "Print",
            __pins: [
              {
                id: "value",
                name: "value",
                kind: "data",
                direction: "in",
                type: { kind: "boxedWildcard" },
              },
            ],
          },
        },
      ],
      edges: [],
    };

    const { container } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );
    const source = container.querySelector(
      '[data-handleid="out"][data-handlepos="right"]',
    );
    const target = container.querySelector(
      '[data-handleid="value"][data-handlepos="left"]',
    );
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    fireEvent.click(source!);
    fireEvent.click(target!);

    const visual = target?.querySelector(".graph-pin-visual") as HTMLElement | null;
    expect(visual?.style.background).toBe("var(--pin-float)");

    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    const persisted = lastGraph.nodes.find((node) => node.id === "print")?.data
      .__pins as Array<{ id: string; type: { kind: string } }>;
    expect(persisted.find((pin) => pin.id === "value")?.type.kind).toBe(
      "boxedWildcard",
    );
  });

  it("enables Format when a node is selected", () => {
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graphWithPins()} />,
    );
    const node = container.querySelector(".react-flow__node");
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    expect(getByTestId("graph-format")).toHaveProperty("disabled", false);
  });

  it("formats the then-chain to the right of a single selected node", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [
        {
          id: "log-a",
          type: "debug.log",
          position: { x: 0, y: 40 },
          data: { message: "A", __pins: debugLogPins },
        },
        {
          id: "log-b",
          type: "debug.log",
          position: { x: 12, y: 180 },
          data: { message: "B", __pins: debugLogPins },
        },
      ],
      edges: [
        {
          id: "e:log-a:execOut:log-b:execIn",
          source: "log-a",
          target: "log-b",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );
    fireEvent.click(container.querySelector(".react-flow__node")!);
    fireEvent.click(getByTestId("graph-format"));

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes.find((node) => node.id === "log-a")?.position).toEqual(
      { x: 0, y: 40 },
    );
    expect(lastGraph.nodes.find((node) => node.id === "log-b")?.position).toEqual({
      x: MARQUEE_FALLBACK_WIDTH + FORMAT_GAP_X,
      y: 40,
    });
  });

  it("formats data inputs to the left of subsequent then-chain nodes", () => {
    const onChange = vi.fn();
    const getterPins = [
      {
        id: "value",
        name: "value",
        kind: "data" as const,
        direction: "out" as const,
        type: { kind: "string" },
      },
    ];
    const graph: GraphDocument = {
      nodes: [
        {
          id: "log-a",
          type: "debug.log",
          position: { x: 0, y: 40 },
          data: { message: "A", __pins: debugLogPins },
        },
        {
          id: "log-b",
          type: "debug.log",
          position: { x: 12, y: 180 },
          data: { message: "B", __pins: debugLogPins },
        },
        {
          id: "get",
          type: "string.literal",
          position: { x: 5, y: 300 },
          data: { __pins: getterPins },
        },
      ],
      edges: [
        {
          id: "e:log-a:execOut:log-b:execIn",
          source: "log-a",
          target: "log-b",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
        {
          id: "e:get:value:log-b:message",
          source: "get",
          target: "log-b",
          sourceHandle: "value",
          targetHandle: "message",
        },
      ],
    };
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );
    fireEvent.click(container.querySelector(".react-flow__node")!);
    fireEvent.click(getByTestId("graph-format"));

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes.find((node) => node.id === "get")?.position).toEqual({
      x: MARQUEE_FALLBACK_WIDTH + FORMAT_GAP_X,
      y: 40,
    });
    expect(lastGraph.nodes.find((node) => node.id === "log-b")?.position).toEqual({
      x: (MARQUEE_FALLBACK_WIDTH + FORMAT_GAP_X) * 2,
      y: 40,
    });
  });

  it("draws a marquee overlay after a stationary pane hold then move", () => {
    const { container, getByTestId } = render(
      <GraphEditor initialGraph={graphWithPins()} />,
    );
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    vi.useFakeTimers();
    act(() => {
      dispatchPointerEvent(pane!, "pointerdown", { clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    act(() => {
      dispatchPointerEvent(pane!, "pointermove", { clientX: 140, clientY: 110 });
    });
    expect(getByTestId("graph-marquee")).toBeTruthy();
  });

  it("selects nodes inside a hold-then-drag marquee", () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        onSelectionChange={onSelectionChange}
      />,
    );
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    vi.useFakeTimers();
    act(() => {
      dispatchPointerEvent(pane!, "pointerdown", { clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    act(() => {
      dispatchPointerEvent(pane!, "pointermove", { clientX: 140, clientY: 110 });
      dispatchPointerEvent(pane!, "pointerup", { clientX: 140, clientY: 110 });
    });
    expect(onSelectionChange).toHaveBeenCalledWith(["log-a"]);
  });

  it("does not deliver pane touchmove after the marquee hold arms", () => {
    const { container } = render(
      <GraphEditor initialGraph={graphWithPins()} />,
    );
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    const paneTouch = vi.fn();
    pane!.addEventListener("touchmove", paneTouch);
    vi.useFakeTimers();
    act(() => {
      dispatchPointerEvent(pane!, "pointerdown", { clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    act(() => {
      pane!.dispatchEvent(
        new MouseEvent("touchmove", {
          bubbles: true,
          cancelable: true,
          clientX: 140,
          clientY: 110,
        }),
      );
    });
    expect(paneTouch).not.toHaveBeenCalled();
  });

  it("titles event nodes Event … when data.title is missing", () => {
    const { getByText } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "begin",
              type: "flow.event.beginPlay",
              position: { x: 0, y: 0 },
              data: { __nodeType: "flow.event.beginPlay" },
            },
          ],
          edges: [],
        }}
      />,
    );
    expect(getByText("Event Begin Play")).toBeTruthy();
  });

  it("removes canvas nodes when initialGraph drops them without emitting onChange", async () => {
    const onChange = vi.fn();
    const graph = graphWithPins();
    const { container, rerender } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);

    onChange.mockClear();
    rerender(
      <GraphEditor
        initialGraph={{ ...graph, nodes: graph.nodes.slice(0, 1) }}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(1);
    });
    expect(container.querySelector('[data-id="log-a"]')).not.toBeNull();
    expect(container.querySelector('[data-id="log-b"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves canvas nodes and drops edges when initialGraph changes without emitting onChange", async () => {
    const onChange = vi.fn();
    const graph = graphWithWiredPins();
    const { container, rerender } = render(
      <GraphEditor initialGraph={graph} onChange={onChange} />,
    );
    expect(container.querySelector('[data-id="log-a"]')).not.toBeNull();
    expect(container.querySelector('[data-id="log-c"]')).not.toBeNull();

    onChange.mockClear();
    const moved: GraphDocument = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "log-a"
          ? { ...node, position: { x: 120, y: 48 } }
          : node,
      ),
      edges: graph.edges.slice(0, 1),
    };
    rerender(<GraphEditor initialGraph={moved} onChange={onChange} />);

    await waitFor(() => {
      const node = container.querySelector(
        '.react-flow__node[data-id="log-a"]',
      ) as HTMLElement | null;
      expect(node?.style.transform).toContain("120px");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a locally added node when the parent echoes the same graph", async () => {
    const onChange = vi.fn();
    const { getByText, container, rerender } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[{ id: "debug.log", title: "Log", category: "Debug" }]}
        onChange={onChange}
      />,
    );

    openPalette(container);
    fireEvent.click(getByText("Log"));

    const emitted = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(emitted.nodes).toHaveLength(1);
    onChange.mockClear();

    rerender(
      <GraphEditor
        initialGraph={emitted}
        paletteNodes={[{ id: "debug.log", title: "Log", category: "Debug" }]}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(1);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides editing chrome and stays read-only", () => {
    const onChange = vi.fn();
    const { queryByTestId, getByTestId } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        onChange={onChange}
        readOnly
      />,
    );
    expect(queryByTestId("graph-toolbar")).toBeNull();
    expect(queryByTestId("graph-delete")).toBeNull();
    expect(getByTestId("graph-editor").getAttribute("data-readonly")).toBe(
      "true",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not delete or copy protected Input nodes", async () => {
    const onChange = vi.fn();
    const { container, getByTestId } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "in-1",
              type: "flow.function.input",
              position: { x: 0, y: 0 },
              data: { __protected: true, title: "Input" },
            },
            {
              id: "log-a",
              type: "debug.log",
              position: { x: 200, y: 0 },
              data: { message: "A", __pins: debugLogPins },
            },
          ],
          edges: [],
        }}
        focusedNodeId="in-1"
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(
        container.querySelector('.react-flow__node.selected[data-id="in-1"]'),
      ).not.toBeNull();
    });
    expect(getByTestId("graph-delete").hasAttribute("disabled")).toBe(true);
    expect(getByTestId("graph-copy").hasAttribute("disabled")).toBe(true);
    expect(container.querySelector('[data-id="in-1"]')).not.toBeNull();
  });

  it("renders a host-provided node type", async () => {
    function MarkerNode() {
      return <div data-testid="custom-marker-node">Marker</div>;
    }
    const { getByTestId } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "m1",
              type: "marker",
              position: { x: 0, y: 0 },
              data: { title: "M" },
            },
          ],
          edges: [],
        }}
        nodeTypes={{ marker: MarkerNode }}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("custom-marker-node").textContent).toBe("Marker");
    });
  });

  it("honors nodesDraggable=false while still allowing selection", () => {
    const { getByTestId } = render(
      <GraphEditor initialGraph={graphWithPins()} nodesDraggable={false} />,
    );
    expect(getByTestId("graph-editor").getAttribute("data-nodes-draggable")).toBe(
      "false",
    );
  });

  it("renders toolbarExtra next to Format", () => {
    const { getByTestId } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        toolbarExtra={<button type="button" data-testid="graph-relayout">Re-layout</button>}
      />,
    );
    expect(getByTestId("graph-relayout")).toBeTruthy();
  });

  it("renders behaviour-tree attached decorator rows", async () => {
    const { getByTestId } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "root",
              type: "bt.node",
              position: { x: 0, y: 0 },
              data: {
                title: "Selector",
                kind: "selector",
                classId: "bt.composite.selector",
                sortIndex: 0,
                decorators: [
                  {
                    id: "dec-1",
                    classId: "bt.decorator.blackboardIsSet",
                    title: "Blackboard Is Set",
                  },
                ],
                services: [],
              },
            },
          ],
          edges: [],
        }}
        nodeTypes={treeNodeTypes}
        nodesDraggable={false}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("bt-node-root")).toBeTruthy();
      expect(getByTestId("bt-decorator-dec-1").textContent).toContain(
        "Blackboard Is Set",
      );
    });
  });

  it("hides Break Links and Format when listed in hiddenToolbarActions", () => {
    const { queryByTestId, getByTestId } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        hiddenToolbarActions={["breakLinks", "format"]}
      />,
    );
    expect(queryByTestId("graph-break-links")).toBeNull();
    expect(queryByTestId("graph-format")).toBeNull();
    expect(getByTestId("graph-delete")).toBeTruthy();
  });

  it("opens a long-press menu on a behaviour-tree node", async () => {
    const wrap = vi.fn();
    const { getByTestId } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "root",
              type: "bt.node",
              position: { x: 0, y: 0 },
              data: {
                title: "Selector",
                kind: "selector",
                classId: "bt.composite.selector",
              },
            },
          ],
          edges: [],
        }}
        nodeTypes={treeNodeTypes}
        contextMenuItemsForNode={() => [
          {
            id: "wrap",
            label: "Wrap In Sequence",
            testId: "bt-menu-wrap",
            onSelect: wrap,
          },
        ]}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("bt-node-root")).toBeTruthy();
    });
    fireEvent.contextMenu(getByTestId("bt-node-root"));
    fireEvent.click(getByTestId("bt-menu-wrap"));
    expect(wrap).toHaveBeenCalled();
  });

  it("opens the selected node menu from the canvas pane", async () => {
    const wrap = vi.fn();
    const { getByTestId, container } = render(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: "root",
              type: "bt.node",
              position: { x: 0, y: 0 },
              data: {
                title: "Selector",
                kind: "selector",
                classId: "bt.composite.selector",
              },
            },
          ],
          edges: [],
        }}
        nodeTypes={treeNodeTypes}
        focusedNodeId="root"
        contextMenuItemsForNode={() => [
          {
            id: "wrap",
            label: "Wrap In Sequence",
            testId: "bt-menu-wrap",
            onSelect: wrap,
          },
        ]}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("bt-node-root")).toBeTruthy();
    });
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.contextMenu(pane!);
    fireEvent.click(getByTestId("bt-menu-wrap"));
    expect(wrap).toHaveBeenCalled();
  });

  it("selects a node added from the palette after the pane click cleared selection", async () => {
    const onSelectionChange = vi.fn();
    const { container, getByText } = render(
      <GraphEditor
        initialGraph={graphWithPins()}
        focusedNodeId="log-a"
        paletteNodes={[{ id: "debug.log", title: "Log", category: "Debug" }]}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith(["log-a"]);
    });
    onSelectionChange.mockClear();
    openPalette(container);
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith([]);
    });
    fireEvent.click(getByText("Log"));
    await waitFor(() => {
      const last = onSelectionChange.mock.calls.at(-1)?.[0] as string[] | undefined;
      expect(last).toHaveLength(1);
      expect(last?.[0]).toMatch(/^debug\.log-/);
    });
  });

  it("uses PaletteNode.nodeType when adding from the palette", async () => {
    const onChange = vi.fn();
    const { container, getByTestId } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        nodeTypes={treeNodeTypes}
        paletteNodes={[
          {
            id: "bt.task.wait",
            title: "Wait",
            category: "Tasks",
            nodeType: "bt.node",
            defaultData: { title: "Wait", classId: "bt.task.wait", kind: "task" },
          },
        ]}
        onChange={onChange}
      />,
    );
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    fireEvent.click(getByTestId("node-palette-item-bt.task.wait"));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const graph = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ type?: string }>;
    };
    expect(graph.nodes[0]?.type).toBe("bt.node");
  });

  it("exposes a canvas drop api for client-to-flow conversion", async () => {
    const onCanvasApi = vi.fn();
    const { getByTestId } = render(
      <GraphEditor initialGraph={createDefaultGraph()} onCanvasApi={onCanvasApi} />,
    );
    await waitFor(() => {
      expect(onCanvasApi).toHaveBeenCalled();
    });
    const api = onCanvasApi.mock.calls.at(-1)?.[0] as {
      containsClientPoint: (x: number, y: number) => boolean;
      clientToFlow: (x: number, y: number) => { x: number; y: number };
    } | null;
    expect(api).toBeTruthy();
    const editor = getByTestId("graph-editor");
    editor.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        right: 210,
        bottom: 220,
        width: 200,
        height: 200,
        x: 10,
        y: 20,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    expect(api?.containsClientPoint(15, 25)).toBe(true);
    expect(api?.containsClientPoint(0, 0)).toBe(false);
    expect(api?.clientToFlow(15, 25)).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });
});

