import { describe, expect, it } from "vitest";
import { NodeShakeTracker } from "./graph-interaction-settings";

type Point = readonly [x: number, y: number];

/** Feeds points 50ms apart after anchoring at `start`; returns the index of each move that fired. */
function shake(points: readonly Point[], start: Point = [0, 0]): number[] {
  const tracker = new NodeShakeTracker();
  tracker.reset(start[0], start[1], 0);
  const fired: number[] = [];
  points.forEach(([x, y], index) => {
    if (tracker.move(x, y, (index + 1) * 50)) fired.push(index);
  });
  return fired;
}

describe("NodeShakeTracker", () => {
  it("fires on the third reversal of a tight back-and-forth", () => {
    // Steps right, left (1), right (2), left (3).
    expect(shake([[20, 0], [0, 0], [20, 0], [0, 0]])).toEqual([3]);
    expect(shake([[30, 0], [-30, 0], [30, 0], [-30, 0]])).toEqual([3]);
    expect(shake([[0, 25], [0, -5], [0, 25], [0, -5], [0, 25]])).toEqual([3, 4]);
  });

  it("ignores moves shorter than a step and drags in one direction", () => {
    expect(shake([[10, 0], [0, 0], [10, 0], [0, 0], [10, 0], [0, 0]])).toEqual([]);
    expect(shake(Array.from({ length: 40 }, (_, index): Point => [(index + 1) * 20, 0]))).toEqual([]);
  });

  it("never fires on a long zig-zag whose strokes leave the shake area", () => {
    const strokes: Point[] = [];
    for (let leg = 0; leg < 6; leg++) {
      for (let step = 1; step <= 10; step++) strokes.push([leg % 2 === 0 ? step * 20 : 200 - step * 20, 0]);
    }
    expect(shake(strokes)).toEqual([]);
  });

  it("fires on a tight shake performed after a long drag", () => {
    const travel = Array.from({ length: 30 }, (_, index): Point => [(index + 1) * 20, 0]);
    expect(shake([...travel, [570, 0], [600, 0], [570, 0]])).toEqual([32]);
  });

  it("does not fire when three reversals spread wider than the shake area", () => {
    // Turns at x = 100, 60 and 170 span 170px, wider than the area.
    expect(shake([[100, 0], [60, 0], [170, 0], [130, 0]])).toEqual([]);
    // The same reversals inside the area fire.
    expect(shake([[100, 0], [60, 0], [150, 0], [110, 0]])).toEqual([3]);
  });

  it("counts only turns sharper than 120 degrees", () => {
    // Right angles: a square traced three times.
    const square: Point[] = [[30, 0], [30, 30], [0, 30], [0, 0]];
    expect(shake([...square, ...square, ...square])).toEqual([]);
    // About 108 degrees each turn: right, then back-left and up, repeatedly.
    expect(shake([[30, 0], [20, 30], [50, 30], [40, 60], [70, 60]])).toEqual([]);
    // About 135 degrees each turn counts.
    expect(shake([[30, 0], [0, 30], [30, 30], [0, 60]])).toEqual([3]);
  });

  it("starts over after a pause longer than 700ms", () => {
    const tracker = new NodeShakeTracker();
    tracker.reset(0, 0, 0);
    expect(tracker.move(30, 0, 100)).toBe(false);
    expect(tracker.move(-30, 0, 200)).toBe(false);
    expect(tracker.move(30, 0, 300)).toBe(false);
    expect(tracker.move(-30, 0, 1001)).toBe(false);
    expect(tracker.move(30, 0, 1100)).toBe(false);
    expect(tracker.move(-30, 0, 1200)).toBe(false);
    expect(tracker.move(30, 0, 1300)).toBe(false);
    expect(tracker.move(-30, 0, 1400)).toBe(true);
  });
});
