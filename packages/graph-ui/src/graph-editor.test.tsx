import { act, fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import { DRAG_ARM_MS } from "@babylonslate/editor-kit";
import { GRAPH_MIN_ZOOM, GraphEditor } from "./graph-editor";
import type { GraphDocument } from "./graph-types";
import { FORMAT_GAP_X } from "./graph-format";
import { MARQUEE_FALLBACK_WIDTH } from "./graph-marquee";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX?: number; clientY?: number } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
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
): void {
  fireEvent.mouseDown(handle, {
    clientX: from.x,
    clientY: from.y,
    button: 0,
  });
  fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(document, { clientX: to.x, clientY: to.y });
}

function openPalette(container: HTMLElement) {
  const pane = container.querySelector(".react-flow__pane");
  expect(pane).not.toBeNull();
  fireEvent.click(pane!);
  fireEvent.click(pane!);
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
});

