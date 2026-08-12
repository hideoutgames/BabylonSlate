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

  it("opens the node palette and adds a node from paletteNodes", () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <GraphEditor
        initialGraph={{ nodes: [], edges: [] }}
        paletteNodes={[
          { id: "debug.log", title: "Log", category: "Debug" },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Add node" }));
    fireEvent.click(getByText("Log"));

    expect(onChange).toHaveBeenCalled();
    const lastGraph = onChange.mock.calls.at(-1)?.[0] as GraphDocument;
    expect(lastGraph.nodes).toHaveLength(1);
    expect(lastGraph.nodes[0]?.type).toBe("debug.log");
    expect(lastGraph.nodes[0]?.data.title).toBe("Log");
  });
});
