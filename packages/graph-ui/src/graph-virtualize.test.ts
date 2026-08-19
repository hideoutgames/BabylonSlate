import { describe, expect, it } from "vitest";
import {
  GRAPH_NODE_FALLBACK_HEIGHT,
  GRAPH_NODE_FALLBACK_WIDTH,
  GRAPH_VIRTUALIZE_OVERSCAN_PX,
  selectVisibleGraphElements,
} from "./graph-virtualize";

function gridNodes(count: number, gap = 400) {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    position: { x: (index % 20) * gap, y: Math.floor(index / 20) * gap },
  }));
}

describe("selectVisibleGraphElements", () => {
  it("renders every node when the measured viewport is 0", () => {
    const nodes = gridNodes(200);
    const edges = [{ id: "e", source: "n0", target: "n1" }];
    const visible = selectVisibleGraphElements(nodes, edges, {
      x: 0,
      y: 0,
      zoom: 1,
      width: 0,
      height: 0,
    });
    expect(visible.nodes).toHaveLength(200);
    expect(visible.edges).toHaveLength(1);
  });

  it("keeps mounted node count near the viewport for a large graph", () => {
    const nodes = gridNodes(400);
    const visible = selectVisibleGraphElements(nodes, [], {
      x: 0,
      y: 0,
      zoom: 1,
      width: 800,
      height: 600,
    });
    expect(visible.nodes.length).toBeGreaterThan(0);
    expect(visible.nodes.length).toBeLessThan(80);
    expect(visible.nodes.some((node) => node.id === "n0")).toBe(true);
    expect(visible.nodes.some((node) => node.id === "n399")).toBe(false);
  });

  it("includes an edge that touches a visible node", () => {
    const nodes = [
      { id: "near", position: { x: 0, y: 0 } },
      { id: "far", position: { x: 8000, y: 8000 } },
    ];
    const edges = [{ id: "link", source: "near", target: "far" }];
    const visible = selectVisibleGraphElements(nodes, edges, {
      x: 0,
      y: 0,
      zoom: 1,
      width: 400,
      height: 300,
    });
    expect(visible.nodes.map((node) => node.id).sort()).toEqual(["far", "near"]);
    expect(visible.edges).toEqual(edges);
  });

  it("keeps an off-screen keepIds node and its incident edge mounted", () => {
    const nodes = [
      { id: "near", position: { x: 0, y: 0 } },
      { id: "focus", position: { x: 8000, y: 8000 } },
      { id: "peer", position: { x: 9000, y: 9000 } },
      { id: "unrelated", position: { x: 12000, y: 12000 } },
    ];
    const edges = [
      { id: "focus-link", source: "focus", target: "peer" },
      { id: "other", source: "unrelated", target: "peer" },
    ];
    const visible = selectVisibleGraphElements(
      nodes,
      edges,
      {
        x: 0,
        y: 0,
        zoom: 1,
        width: 400,
        height: 300,
      },
      GRAPH_VIRTUALIZE_OVERSCAN_PX,
      ["focus"],
    );
    expect(visible.nodes.map((node) => node.id).sort()).toEqual([
      "focus",
      "near",
      "peer",
    ]);
    expect(visible.edges.map((edge) => edge.id)).toEqual(["focus-link"]);
  });

  it("uses the named overscan and fallback node size", () => {
    expect(GRAPH_VIRTUALIZE_OVERSCAN_PX).toBeGreaterThan(0);
    expect(GRAPH_NODE_FALLBACK_WIDTH).toBeGreaterThan(0);
    expect(GRAPH_NODE_FALLBACK_HEIGHT).toBeGreaterThan(0);
  });
});
