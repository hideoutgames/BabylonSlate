import { Position } from "@xyflow/react";

const ANIM_TRANSITION_CURVATURE = 0.85;
export const ANIM_TRANSITION_MIN_STUB = 64;

export type AnimTransitionPathParams = {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
};

export type AnimTransitionPath = {
  path: string;
  labelX: number;
  labelY: number;
  angle: number;
};

function stubAlong(
  from: number,
  to: number,
): number {
  return Math.max(
    ANIM_TRANSITION_MIN_STUB,
    Math.abs(to - from) * ANIM_TRANSITION_CURVATURE,
  );
}

function controlPoint(
  x: number,
  y: number,
  otherX: number,
  otherY: number,
  position: Position,
): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: x - stubAlong(x, otherX), y };
    case Position.Right:
      return { x: x + stubAlong(x, otherX), y };
    case Position.Top:
      return { x, y: y - stubAlong(y, otherY) };
    case Position.Bottom:
      return { x, y: y + stubAlong(y, otherY) };
    default:
      return { x, y };
  }
}

function cubicMidpoint(
  sourceX: number,
  sourceY: number,
  sourceControlX: number,
  sourceControlY: number,
  targetControlX: number,
  targetControlY: number,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  return {
    x:
      sourceX * 0.125 +
      sourceControlX * 0.375 +
      targetControlX * 0.375 +
      targetX * 0.125,
    y:
      sourceY * 0.125 +
      sourceControlY * 0.375 +
      targetControlY * 0.375 +
      targetY * 0.125,
  };
}

export type AnimTransitionCurve = {
  source: { x: number; y: number };
  sourceControl: { x: number; y: number };
  targetControl: { x: number; y: number };
  target: { x: number; y: number };
};

/** The cubic Bézier a transition wire draws, as its four points. */
export function animTransitionCurve({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: AnimTransitionPathParams): AnimTransitionCurve {
  return {
    source: { x: sourceX, y: sourceY },
    sourceControl: controlPoint(sourceX, sourceY, targetX, targetY, sourcePosition),
    targetControl: controlPoint(targetX, targetY, sourceX, sourceY, targetPosition),
    target: { x: targetX, y: targetY },
  };
}

export function animTransitionPath(params: AnimTransitionPathParams): AnimTransitionPath {
  const { sourceX, sourceY, targetX, targetY } = params;
  const { sourceControl, targetControl } = animTransitionCurve(params);
  const mid = cubicMidpoint(
    sourceX,
    sourceY,
    sourceControl.x,
    sourceControl.y,
    targetControl.x,
    targetControl.y,
    targetX,
    targetY,
  );
  let tangentX =
    0.75 * (sourceControl.x - sourceX) +
    1.5 * (targetControl.x - sourceControl.x) +
    0.75 * (targetX - targetControl.x);
  let tangentY =
    0.75 * (sourceControl.y - sourceY) +
    1.5 * (targetControl.y - sourceControl.y) +
    0.75 * (targetY - targetControl.y);
  // On a short hop the minimum stubs cross, so the curve doubles back at its
  // midpoint while the wire still reads source-to-target.
  if (tangentX * (targetX - sourceX) + tangentY * (targetY - sourceY) < 0) {
    tangentX = -tangentX;
    tangentY = -tangentY;
  }
  return {
    path: `M ${sourceX},${sourceY} C ${sourceControl.x},${sourceControl.y} ${targetControl.x},${targetControl.y} ${targetX},${targetY}`,
    labelX: mid.x,
    labelY: mid.y,
    angle: (Math.atan2(tangentY, tangentX) * 180) / Math.PI,
  };
}

export type AnimStateSide = "top" | "right" | "bottom" | "left";

const SIDE_POSITIONS: Record<AnimStateSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * Where a transition wire meets a state card's side: the side's midpoint, 2px outside the border (the side plates
 * stick out, and the wire's ends are pulled back onto the border, see `AnimTransitionEdge`).
 */
export function animTransitionEnd(
  box: { x: number; y: number; width: number; height: number },
  side: AnimStateSide,
): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: box.x + box.width / 2, y: box.y - 2 };
    case "bottom":
      return { x: box.x + box.width / 2, y: box.y + box.height + 2 };
    case "left":
      return { x: box.x - 2, y: box.y + box.height / 2 };
    case "right":
      return { x: box.x + box.width + 2, y: box.y + box.height / 2 };
  }
}

/** The curve a transition draws between two state boxes leaving and entering by the given sides. */
export function animTransitionCurveBetween(
  from: { x: number; y: number; width: number; height: number },
  sourceSide: AnimStateSide,
  to: { x: number; y: number; width: number; height: number },
  targetSide: AnimStateSide,
): AnimTransitionCurve {
  const source = animTransitionEnd(from, sourceSide);
  const target = animTransitionEnd(to, targetSide);
  return animTransitionCurve({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: SIDE_POSITIONS[sourceSide],
    targetX: target.x,
    targetY: target.y,
    targetPosition: SIDE_POSITIONS[targetSide],
  });
}
