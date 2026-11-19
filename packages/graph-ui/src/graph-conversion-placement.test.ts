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

  const sortedMoves = (placed: ReturnType<typeof placeConversion>) =>
    [...placed.moves].sort((a, b) => a.id.localeCompare(b.id));

  it("pushes a neighbour in the way left by the same amount instead of giving up", () => {
    // `wall` (-200..-50) sits 50 left of the source: the source moving 160 left would land on it, so it moves 160 too.
    const placed = place([box("source", 0, 0), box("target", 600, 0), box("wall", -200, 0, false, 150)]);
    expect(placed.position).toEqual({ x: 160, y: 0 });
    expect(sortedMoves(placed)).toEqual([
      { id: "source", position: { x: -160, y: 0 } },
      { id: "wall", position: { x: -360, y: 0 } },
    ]);
  });

  it("pushes a chain of neighbours, exec nodes included, each by the same amount", () => {
    // Each 30 left of the next: the source hits `near`, `near` hits the exec node `far`; `aside`, 200 below `far`, is
    // never in the way.
    const placed = place([
      box("source", 0, 0),
      box("target", 600, 0),
      box("near", -180, 20, false, 150),
      box("far", -360, -10, true, 150),
      box("aside", -560, 190),
    ]);
    expect(placed.position).toEqual({ x: 160, y: 0 });
    expect(sortedMoves(placed)).toEqual([
      { id: "far", position: { x: -520, y: -10 } },
      { id: "near", position: { x: -340, y: 20 } },
      { id: "source", position: { x: -160, y: 0 } },
    ]);
  });

  it("leaves a neighbour already close above the source where it is, but pushes one already close to its left", () => {
    const placed = place([
      box("source", 0, 0),
      box("target", 600, 0),
      box("above", -100, -110),
      box("left", -170, 0, false, 150),
    ]);
    expect(sortedMoves(placed)).toEqual([
      { id: "left", position: { x: -330, y: 0 } },
      { id: "source", position: { x: -160, y: 0 } },
    ]);
  });

  it("settles a long chain, every node in it joining once", () => {
    // Forty 150-wide nodes 30 apart behind the source: each is pushed by the one to its right.
    const chain = Array.from({ length: 40 }, (_, index) => box(`n${index}`, -180 * (index + 1), 0, false, 150));
    const placed = place([box("source", 0, 0), box("target", 600, 0), ...chain]);
    expect(placed.moves).toHaveLength(41);
    expect(placed.moves.find((move) => move.id === "n39")?.position).toEqual({ x: -7360, y: 0 });
  });

  it.each([
    ["the target", box("feeder", 900, 0)],
    ["a node at or right of the converter's slot", box("feeder", 520, 300)],
  ])("moves nothing when the push would reach %s, and puts the converter one gap left of the target", (_case, feeder) => {
    // The source's only feeder sits so that moving it 160 left runs it into the target, or into `post` (left edge 300,
    // right of the slot at 160).
    const placed = place(
      [box("source", 0, 0), box("target", 600, 0), feeder, box("post", 300, 300)],
      [{ source: "feeder", target: "source" }],
    );
    expect(placed).toEqual({ position: { x: 160, y: 124 }, moves: [] });
  });

  it("keeps the moves and pushes the converter down when a node it cannot push holds the converter's spot", () => {
    // `between` (y -20..40) is in the slot but nothing moving runs into it: the converter goes below it, 40 + 24.
    const placed = place([box("source", 0, 0), box("target", 600, 0), box("between", 260, -20, true, 100, 60)]);
    expect(placed.moves).toEqual([{ id: "source", position: { x: -160, y: 0 } }]);
    expect(placed.position).toEqual({ x: 160, y: 64 });
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
    // Output on the second row: 44 further down than the first row.
    const placed = place([box("source", 0, 0), box("target", 1000, 0)], [], { converter: { ...converter, outY: 116 } });
    expect(placed.position).toEqual({ x: 440, y: -44 });
  });

  it("lands the converter on the snap grid and moves nodes by whole grid cells covering the shortfall", () => {
    // Converter: x floor(160 / 16) * 16 = 160; y round((77 - 72) / 16) * 16 = 0. Shortfall 208 + 120 - 160 = 168,
    // rounded up to 11 cells = 176, so grid-aligned nodes stay aligned: the source goes from 16 to -160 and the feeder
    // from -384 to -560.
    const placed = place(
      [box("source", 16, 0, false, 192), box("target", 608, 0), box("feeder", -384, 32)],
      [{ source: "feeder", target: "source" }],
      { targetPoint: { x: 608, y: 77 }, snapGrid: 16 },
    );
    expect(placed.position).toEqual({ x: 160, y: 0 });
    expect(sortedMoves(placed)).toEqual([
      { id: "feeder", position: { x: -560, y: 32 } },
      { id: "source", position: { x: -160, y: 0 } },
    ]);
  });

  it("snaps a converter that fits in the gap to a grid line inside it", () => {
    const placed = place([box("source", 0, 0), box("target", 1000, 0)], [], { snapGrid: 16 });
    expect(placed.position).toEqual({ x: 448, y: 0 });
  });
});
