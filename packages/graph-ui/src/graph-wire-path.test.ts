import { describe, expect, it } from "vitest";
import { graphWireEase, graphWirePath, sampleGraphWire } from "./graph-wire-path";

/** The path's numbers in order, from its `M x,y L … C …` string. */
function numbers(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

/** Height of a sampled wire at `x`, read off the two samples around it. */
function heightAt(points: readonly { x: number; y: number }[], x: number): number {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (x >= a.x && x <= b.x) return b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  throw new Error(`x ${x} is not on the wire`);
}

describe("graphWirePath", () => {
  it("draws a level wire as one straight line", () => {
    expect(graphWirePath(0, 50, 400, 50)[0]).toBe("M0,50 L400,50");
  });

  it("leaves and enters level, easing once in the middle of a long wire over 1.2 × the height", () => {
    // 100 high: the ease spans 120, centred on the 600-long wire (240 to 360).
    const [path, labelX, labelY] = graphWirePath(0, 0, 600, 100);
    expect(path).toBe("M0,0 L240,0 C300,0 300,100 360,100 L600,100");
    expect([labelX, labelY]).toEqual([300, 50]);
    expect(graphWireEase(0, 0, 600, 100)).toEqual([240, 360]);
  });

  it("keeps the ease between 48 and 200 across, and within a wire shorter than that", () => {
    expect(graphWireEase(0, 0, 1000, 10)).toEqual([476, 524]);
    expect(graphWireEase(0, 0, 1000, 500)).toEqual([400, 600]);
    expect(graphWireEase(0, 0, 80, 500)).toEqual([0, 80]);
  });

  it("eases two wires between the same columns alike, so they run parallel", () => {
    const upper = sampleGraphWire(100, 0, 700, 200, 40);
    const lower = sampleGraphWire(100, 60, 700, 260, 40);
    for (let x = 100; x <= 700; x += 25) expect(heightAt(lower, x) - heightAt(upper, x)).toBeCloseTo(60, 6);
  });

  it("makes the ease a symmetric S, horizontal at both ends", () => {
    const [, ...rest] = numbers(graphWirePath(0, 0, 600, 100)[0]);
    // L240,0 C300,0 300,100 360,100: both control points sit over the middle, at each end's height.
    const [startX, startY, c1x, c1y, c2x, c2y, endX, endY] = rest.slice(1, 9);
    expect(c1y).toBe(startY);
    expect(c2y).toBe(endY);
    expect(c1x).toBe(c2x);
    expect(c1x! - startX!).toBe(endX! - c2x!);
    const points = sampleGraphWire(0, 0, 600, 100, 64);
    // Mirror symmetry about the ease's middle (300, 50).
    for (const offset of [10, 25, 40, 55]) {
      expect(heightAt(points, 300 - offset) + heightAt(points, 300 + offset)).toBeCloseTo(100, 0);
    }
    expect(heightAt(points, 239)).toBe(0);
    expect(heightAt(points, 361)).toBe(100);
  });

  it("keeps a loop for a wire that runs backwards", () => {
    const [path] = graphWirePath(500, 0, 100, 80);
    // XYFlow's bezier: control points 0.25 × 25 × √400 = 125 out from each end.
    expect(path).toBe("M500,0 C625,0 -25,80 100,80");
  });

  it("samples the same wire it draws, ends included", () => {
    const points = sampleGraphWire(0, 0, 600, 100, 8);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[1]).toEqual({ x: 240, y: 0 });
    expect(points.at(-2)).toEqual({ x: 360, y: 100 });
    expect(points.at(-1)).toEqual({ x: 600, y: 100 });
    expect(sampleGraphWire(0, 40, 300, 40, 8)).toEqual([{ x: 0, y: 40 }, { x: 300, y: 40 }]);
  });
});
