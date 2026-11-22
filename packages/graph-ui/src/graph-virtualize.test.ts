import { describe, expect, it } from "vitest";
import {
  estimateGraphNodeSize,
  graphNodesBounds,
  graphPinRowCenterY,
  GRAPH_NODE_FALLBACK_HEIGHT,
  GRAPH_NODE_FALLBACK_WIDTH,
  GRAPH_VIRTUALIZE_OVERSCAN_PX,
  selectVisibleGraphElements,
  cullStillHolds,
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

  it("keeps an unmeasured pin-heavy node whose lower pins reach the viewport", () => {
    const pins = Array.from({ length: 20 }, (_, index) => ({
      id: `in${index}`,
      direction: "in",
    }));
    const nodes = [
      { id: "tall", position: { x: 0, y: -1000 }, data: { __pins: pins } },
      { id: "short", position: { x: 400, y: -1000 }, data: { __pins: pins.slice(0, 1) } },
    ];
    const visible = selectVisibleGraphElements(nodes, [], {
      x: 0,
      y: 0,
      zoom: 1,
      width: 800,
      height: 600,
    });
    expect(visible.nodes.map((node) => node.id)).toEqual(["tall"]);
  });

  it("keeps both ends of a selected off-screen edge mounted", () => {
    const nodes = [
      { id: "near", position: { x: 0, y: 0 } },
      { id: "from", position: { x: 8000, y: 8000 } },
      { id: "to", position: { x: 9000, y: 9000 } },
    ];
    const edges = [
      { id: "picked", source: "from", target: "to", selected: true },
      { id: "idle", source: "to", target: "from" },
    ];
    const viewport = { x: 0, y: 0, zoom: 1, width: 400, height: 300 };
    expect(
      selectVisibleGraphElements(nodes, edges, viewport).edges.map((edge) => edge.id),
    ).toEqual(["picked", "idle"]);
    expect(
      selectVisibleGraphElements(
        nodes,
        edges.map((edge) => ({ ...edge, selected: false })),
        viewport,
      ).edges,
    ).toEqual([]);
  });

  it("uses the named overscan and fallback node size", () => {
    expect(GRAPH_VIRTUALIZE_OVERSCAN_PX).toBeGreaterThan(0);
    expect(GRAPH_NODE_FALLBACK_WIDTH).toBeGreaterThan(0);
    expect(GRAPH_NODE_FALLBACK_HEIGHT).toBeGreaterThan(0);
  });
});

describe("unmeasured pin node geometry", () => {
  // Measured in the editor at Large Pins 1: Get Actor Location (one row) is 96 tall with both handles 69 below its
  // top; Set Actor Location (three rows) is 184 tall with handles at 69, 113 and 157; Make Array (one row plus its
  // Add Pin control) is 140 tall.
  it("estimates a node's height from its pin rows as the editor renders them", () => {
    expect(estimateGraphNodeSize([{ direction: "in" }, { direction: "out" }]).height).toBe(96);
    const setLocation = [{ direction: "in" }, { direction: "out" }, { direction: "in" }, { direction: "in" }];
    expect(estimateGraphNodeSize(setLocation).height).toBe(184);
    expect(estimateGraphNodeSize([{ direction: "in" }, { direction: "out" }], { __addPin: { side: "in", label: "Add Pin" } }).height)
      .toBe(140);
  });

  it("puts each pin row's handle centre where the editor draws it", () => {
    expect([0, 1, 2].map(graphPinRowCenterY)).toEqual([69, 113, 157]);
  });

  it("keeps header pins out of the row count and unknown pins at the fallback height", () => {
    expect(estimateGraphNodeSize([{ direction: "in", placement: "header" }, { direction: "out" }]).height).toBe(96);
    expect(estimateGraphNodeSize(undefined).height).toBe(GRAPH_NODE_FALLBACK_HEIGHT);
  });
});

describe("Reroute knot size", () => {
  it("estimates an unmeasured knot at its small size, not a node's", () => {
    const pins = [{ direction: "in" }, { direction: "out" }];
    expect(estimateGraphNodeSize(pins, { __reroute: true })).toEqual({ width: 80, height: 35 });
    expect(graphNodesBounds([{ id: "knot", position: { x: 100, y: 50 }, data: { __reroute: true, __pins: pins } }]))
      .toEqual({ x: 100, y: 50, width: 80, height: 35 });
  });
});

describe("cullStillHolds", () => {
  it("skips a rescan only for pans whose cull would mount the very same nodes and wires", () => {
    // Deterministic scatter of nodes with uneven sizes, and wires between neighbours.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      id: `n${index}`,
      position: { x: Math.round(random() * 6000), y: Math.round(random() * 4000) },
      width: 120 + Math.round(random() * 300),
      height: 60 + Math.round(random() * 200),
    }));
    const edges = nodes.slice(1).map((node, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: node.id }));
    const ids = (result: { nodes: { id: string }[]; edges: { id: string }[] }) =>
      [result.nodes.map((node) => node.id), result.edges.map((edge) => edge.id)];
    let anchor = { x: -1000, y: -800, zoom: 0.75, width: 1200, height: 800 };
    let culled = selectVisibleGraphElements(nodes, edges, anchor, 100, ["n5"]);
    let held = 0;
    let recut = 0;
    for (let step = 0; step < 400; step++) {
      const next = { ...anchor, x: anchor.x + (random() - 0.5) * 20, y: anchor.y + (random() - 0.5) * 20 };
      const fresh = selectVisibleGraphElements(nodes, edges, next, 100, ["n5"]);
      if (cullStillHolds(anchor, next, culled.hold)) {
        held += 1;
        expect(ids(fresh)).toEqual(ids(culled));
      } else {
        recut += 1;
        anchor = next;
        culled = fresh;
      }
    }
    // Most pans of up to 10 px keep the set; some still cross a node edge.
    expect(held).toBeGreaterThan(recut);
    expect(recut).toBeGreaterThan(0);
  });

  it("never holds across a zoom or resize, or without a hold", () => {
    const nodes = gridNodes(10);
    const viewport = { x: -37, y: -23, zoom: 1, width: 800, height: 600 };
    const { hold } = selectVisibleGraphElements(nodes, [], viewport);
    expect(cullStillHolds(viewport, viewport, hold)).toBe(true);
    expect(cullStillHolds(viewport, { ...viewport, zoom: 1.1 }, hold)).toBe(false);
    expect(cullStillHolds(viewport, { ...viewport, width: 801 }, hold)).toBe(false);
    expect(cullStillHolds(viewport, viewport, undefined)).toBe(false);
    expect(selectVisibleGraphElements(nodes, [], { ...viewport, width: 0 }).hold).toBeUndefined();
  });
});
