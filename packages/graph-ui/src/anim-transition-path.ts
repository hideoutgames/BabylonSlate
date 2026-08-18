import { Position } from "@xyflow/react";

export const ANIM_TRANSITION_CURVATURE = 0.85;
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

export function animTransitionPath({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: AnimTransitionPathParams): AnimTransitionPath {
  const sourceControl = controlPoint(
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
  );
  const targetControl = controlPoint(
    targetX,
    targetY,
    sourceX,
    sourceY,
    targetPosition,
  );
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
  const tangentX =
    0.75 * (sourceControl.x - sourceX) +
    1.5 * (targetControl.x - sourceControl.x) +
    0.75 * (targetX - targetControl.x);
  const tangentY =
    0.75 * (sourceControl.y - sourceY) +
    1.5 * (targetControl.y - sourceControl.y) +
    0.75 * (targetY - targetControl.y);
  return {
    path: `M ${sourceX},${sourceY} C ${sourceControl.x},${sourceControl.y} ${targetControl.x},${targetControl.y} ${targetX},${targetY}`,
    labelX: mid.x,
    labelY: mid.y,
    angle: (Math.atan2(tangentY, tangentX) * 180) / Math.PI,
  };
}
