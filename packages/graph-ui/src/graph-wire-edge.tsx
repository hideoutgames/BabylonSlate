import { memo } from "react";
import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { graphWirePathBetween } from "./graph-wire-between";

/**
 * The default GraphEditor edge: a script wire drawn with `graphWirePath`. `BaseEdge` keeps the
 * path element, interaction band, markers and label that selection, Cut Links and run flashes
 * read.
 */
export const GraphWireEdge = memo(function GraphWireEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
}: EdgeProps) {
  const [path, labelX, labelY] = graphWirePathBetween({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
});
