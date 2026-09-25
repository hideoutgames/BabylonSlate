import { describe, expect, it } from "vitest";
import { getBezierPath, Position } from "@xyflow/react";
import {
  ANIM_TRANSITION_CURVATURE,
  ANIM_TRANSITION_MIN_STUB,
  animTransitionPath,
} from "./anim-transition-path";

const horizontal = {
  sourceX: 0,
  sourceY: 40,
  sourcePosition: Position.Right,
  targetX: 200,
  targetY: 40,
  targetPosition: Position.Left,
};

function firstControlX(path: string): number {
  const match = /C\s*([-\d.]+)/.exec(path);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe("animTransitionPath", () => {
  it("uses a stronger curvature and a minimum stub than stock bezier", () => {
    expect(ANIM_TRANSITION_CURVATURE).toBeGreaterThan(0.25);
    expect(ANIM_TRANSITION_MIN_STUB).toBeGreaterThanOrEqual(48);
  });

  it("bows further along the handle than default getBezierPath", () => {
    const [stock] = getBezierPath(horizontal);
    const { path } = animTransitionPath(horizontal);
    expect(firstControlX(path)).toBeGreaterThan(firstControlX(stock));
    expect(firstControlX(path)).toBeGreaterThanOrEqual(ANIM_TRANSITION_MIN_STUB);
  });

  it("keeps a spacious stub on a short hop", () => {
    const { path } = animTransitionPath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 40,
      targetY: 0,
      targetPosition: Position.Left,
    });
    expect(firstControlX(path)).toBeGreaterThanOrEqual(ANIM_TRANSITION_MIN_STUB);
  });

  it("points the badge from source to target on a short hop", () => {
    const hop = {
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      targetY: 0,
    };
    expect(animTransitionPath({ ...hop, targetX: 40 }).angle).toBeCloseTo(0);
    expect(animTransitionPath({ ...hop, targetX: 400 }).angle).toBeCloseTo(0);
  });

  it("points a backward transition badge toward its target", () => {
    const { angle } = animTransitionPath({
      sourceX: 400,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 0,
      targetY: 0,
      targetPosition: Position.Left,
    });
    expect(Math.abs(angle)).toBeCloseTo(180);
  });
});
