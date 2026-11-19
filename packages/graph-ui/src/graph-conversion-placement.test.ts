import { describe, expect, it } from "vitest";
import { placeConversion, type ConversionPlacementInput, type ConversionPlacementNode } from "./graph-conversion-placement";

// Hand-derived geometry: the Format gap is 120, the converter 320 x 116 with its output 72 below its top, so it
// needs 560 between the source's right edge and the target's left edge, and its output sits level with a target
// pin at y = 72 when its top is at 0.
const converter = { width: 320, height: 116, outY: 72 };

function box(id: string, x: number, y: number, exec = false, width = 200, height = 100): ConversionPlacementNode {
  return { id, x, y, width, height, exec };
}

function place(
  nodes: ConversionPlacementNode[],
  edges: ConversionPlacementInput["edges"] = [],
  overrides: Partial<ConversionPlacementInput> = {},
) {
  const source = nodes.find((node) => node.id === "source")!;
  const target = nodes.find((node) => node.id === "target")!;
  return placeConversion({
    nodes,
    edges,
    source: "source",
    sourcePoint: { x: source.x + source.width, y: source.y + 72 },
    target: "target",
    targetPoint: { x: target.x, y: target.y + 72 },
    converter,
    ...overrides,
  });
}

describe("placeConversion", () => {
  it("centres the converter in a gap that holds it, output level with the target pin, and moves nothing", () => {
    // Gap 200..1000: the converter's left edge may run from 320 to 560; the middle is 440.
    expect(place([box("source", 0, 40), box("target", 1000, 0)])).toEqual({ position: { x: 440, y: 0 }, moves: [] });
  });

  it("uses a gap that holds the converter exactly", () => {
    expect(place([box("source", 0, 0), box("target", 760, 0)])).toEqual({ position: { x: 320, y: 0 }, moves: [] });
  });

  it("moves the source and the nodes that only feed it left by exactly the shortfall", () => {
    // Gap 200..600 is 160 short: the converter goes at 600 - 120 - 320 = 160 and the source's right edge to 40.
    const nodes = [
      box("source", 0, 0),
      box("target", 600, 0, true),
      box("feeder", -400, 0),
      box("feederOfFeeder", -800, 0),
      box("feedsBoth", -400, 200),
      box("shared", -400, 400),
      box("execFeeder", -400, -400, true),
      box("consumer", 1000, 300),
    ];
    const edges = [
      { source: "feeder", target: "source" },
      { source: "feederOfFeeder", target: "feeder" },
      { source: "feedsBoth", target: "source" },
      { source: "feedsBoth", target: "feeder" },
      { source: "shared", target: "source" },
      { source: "shared", target: "consumer" },
      { source: "execFeeder", target: "source" },
      { source: "source", target: "target" },
      { source: "source", target: "consumer" },
    ];
    const placed = place(nodes, edges);
    expect(placed.position).toEqual({ x: 160, y: 0 });
    expect([...placed.moves].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "feeder", position: { x: -560, y: 0 } },
      { id: "feederOfFeeder", position: { x: -960, y: 0 } },
      { id: "feedsBoth", position: { x: -560, y: 200 } },
      { id: "source", position: { x: -160, y: 0 } },
    ]);
  });

  it("moves an exec source alone, never its feeders", () => {
    const placed = place(
      [box("source", 0, 0, true), box("target", 600, 0), box("feeder", -400, 0)],
      [{ source: "feeder", target: "source" }],
    );
    expect(placed).toEqual({ position: { x: 160, y: 0 }, moves: [{ id: "source", position: { x: -160, y: 0 } }] });
  });

  it("never moves the target, even when it only feeds the source", () => {
    const placed = place(
      [box("source", 0, 0), box("target", 600, 0)],
      [{ source: "target", target: "source" }],
    );
    expect(placed.moves).toEqual([{ id: "source", position: { x: -160, y: 0 } }]);
  });

  it("moves nothing when the move would bring a moved node onto another, and goes below the pair instead", () => {
    // `wall` sits just left of the source: moving the source 160 left would land on it. The converter keeps x = 160
    // and is pushed down past the source (bottom 100, plus the 24 placement gap).
    const placed = place([box("source", 0, 0), box("target", 600, 0), box("wall", -200, 0, false, 150)]);
    expect(placed).toEqual({ position: { x: 160, y: 124 }, moves: [] });
  });

  it("moves nothing when a node outside the moved set holds the converter's spot", () => {
    const placed = place([box("source", 0, 0), box("target", 600, 0), box("between", 260, -20, true, 100, 60)]);
    expect(placed.moves).toEqual([]);
    expect(placed.position).toEqual({ x: 160, y: 124 });
  });

  it.each([
    ["right of", { x: 900, y: 0 }],
    ["above", { x: 600, y: -300 }],
    ["below", { x: 560, y: 300 }],
  ])("moves nothing when the source is %s the target, and places the converter one gap left of it", (_case, at) => {
    const placed = place([box("source", at.x, at.y), box("target", 600, 0)]);
    expect(placed).toEqual({ position: { x: 160, y: 0 }, moves: [] });
  });

  it("pushes the converter straight down past every node in its column, never up", () => {
    // A tall node met first and a short one inside it: the converter lands below the tall one.
    const tall = place([box("source", 900, 0), box("target", 600, 0), box("tall", 100, -50, true, 200, 1000), box("short", 200, 10)]);
    expect(tall.position).toEqual({ x: 160, y: 974 });
    // Two stacked nodes with too little room between them: below both.
    const stacked = place([box("source", 900, 0), box("target", 600, 0), box("upper", 100, 0), box("lower", 100, 130)]);
    expect(stacked.position).toEqual({ x: 160, y: 254 });
  });

  it("levels the converter's output, not its first row, with the target pin", () => {
    // Output on the second row: 50 of chrome, one 44 row, half a row.
    const placed = place([box("source", 0, 0), box("target", 1000, 0)], [], { converter: { ...converter, outY: 116 } });
    expect(placed.position).toEqual({ x: 440, y: -44 });
  });

  it("lands every moved node and the converter on the snap grid, moving nodes at least the shortfall", () => {
    // Converter: x floor(160 / 16) * 16 = 160; y round((77 - 72) / 16) * 16 = 0. Shortfall 203 + 120 - 160 = 163,
    // so the source goes from 3 to floor(-160 / 16) * 16 = -160 and the feeder from -382 to floor(-545 / 16) * 16 = -560.
    const placed = place(
      [box("source", 3, 5), box("target", 600, 0), box("feeder", -382, 3)],
      [{ source: "feeder", target: "source" }],
      { targetPoint: { x: 600, y: 77 }, snapGrid: 16 },
    );
    expect(placed.position).toEqual({ x: 160, y: 0 });
    expect([...placed.moves].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "feeder", position: { x: -560, y: 0 } },
      { id: "source", position: { x: -160, y: 0 } },
    ]);
  });

  it("snaps a converter that fits in the gap to a grid line inside it", () => {
    const placed = place([box("source", 0, 0), box("target", 1000, 0)], [], { snapGrid: 16 });
    expect(placed.position).toEqual({ x: 448, y: 0 });
  });
});
