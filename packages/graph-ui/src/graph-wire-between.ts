import { getBezierPath, Position } from "@xyflow/react";
import { graphWirePath } from "./graph-wire-path";

/**
 * `graphWirePath` for a wire between handles that face each other across the canvas (an output
 * on the right, an input on the left, drawn either way round); other handle sides, such as a
 * behaviour tree's top and bottom, keep XYFlow's bezier.
 */
export function graphWirePathBetween(params: {
  sourceX: number;
  sourceY: number;
  sourcePosition?: Position;
  targetX: number;
  targetY: number;
  targetPosition?: Position;
}): [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number] {
  const { sourceX, sourceY, sourcePosition = Position.Right, targetX, targetY, targetPosition = Position.Left } = params;
  if (sourcePosition === Position.Right && targetPosition === Position.Left) {
    return graphWirePath(sourceX, sourceY, targetX, targetY);
  }
  if (sourcePosition === Position.Left && targetPosition === Position.Right) {
    return graphWirePath(targetX, targetY, sourceX, sourceY);
  }
  return getBezierPath(params);
}
