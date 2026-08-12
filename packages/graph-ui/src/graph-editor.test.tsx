import { fireEvent, render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument } from "./graph-types";

afterEach(cleanup);

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

function openPalette(container: HTMLElement) {
  const pane = container.querySelector(".react-flow__pane");
  expect(pane).not.toBeNull();
  fireEvent.click(pane!);
  fireEvent.click(pane!);
}

describe("GraphEditor", () => {
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

