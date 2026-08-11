import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import { GraphEditor } from "./graph-editor";

afterEach(cleanup);

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
});
