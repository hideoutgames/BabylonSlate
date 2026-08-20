import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  useReactFlow,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { cn } from "@babylonslate/ui/lib/utils";
import { displayNodeTitle } from "./graph-connect";
import { animTransitionPath } from "./anim-transition-path";

type AnimStateSide = "top" | "right" | "bottom" | "left";

const ANIM_STATE_SIDES: readonly AnimStateSide[] = [
  "top",
  "right",
  "bottom",
  "left",
];

type AnimStateData = {
  title?: string;
  entry?: boolean;
  __nodeType?: string;
};

const SIDE_POSITION: Record<AnimStateSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

export function AnimStateNode({
  id,
  data,
  selected,
}: NodeProps<Node<AnimStateData>>) {
  const title = displayNodeTitle(
    typeof data.__nodeType === "string" ? data.__nodeType : "anim.state",
    typeof data.title === "string" ? data.title : undefined,
  );
  return (
    <div
      className={cn(
        "anim-state-node",
        selected && "anim-state-node-selected",
        data.entry === true && "anim-state-node-entry",
      )}
      data-testid={`anim-state-node-${id}`}
    >
      {ANIM_STATE_SIDES.map((side) => (
        <span key={side}>
          <Handle
            type="target"
            position={SIDE_POSITION[side]}
            id={`${side}-in`}
            className={cn(
              "anim-state-handle anim-state-handle-target",
              `anim-state-handle-${side}`,
            )}
          />
          <Handle
            type="source"
            position={SIDE_POSITION[side]}
            id={`${side}-out`}
            className={cn(
              "anim-state-handle anim-state-handle-source",
              `anim-state-handle-${side}`,
            )}
          />
        </span>
      ))}
      <div className="anim-state-node-title">{title}</div>
      {data.entry === true ? (
        <div className="anim-state-node-entry-mark" aria-hidden>
          Entry
        </div>
      ) : null}
    </div>
  );
}

export function AnimTransitionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  selected,
  type,
}: EdgeProps) {
  const { setEdges, setNodes } = useReactFlow();
  const { path: edgePath, labelX, labelY, angle } = animTransitionPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const bidirectional = type === "animTransitionBoth";
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        markerEnd={markerEnd}
        markerStart={bidirectional ? markerStart : undefined}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn(
            "anim-transition-badge nodrag nopan",
            selected && "anim-transition-badge-selected",
            bidirectional && "anim-transition-badge-both",
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) rotate(${angle}deg)`,
          }}
          data-testid={`anim-transition-badge-${id}`}
          data-bidirectional={bidirectional ? "true" : undefined}
          aria-label="Select Transition"
          onClick={(event) => {
            event.stopPropagation();
            setNodes((current) =>
              current.map((node) =>
                node.selected ? { ...node, selected: false } : node,
              ),
            );
            setEdges((current) =>
              current.map((edge) => ({
                ...edge,
                selected: edge.id === id,
              })),
            );
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
        />
      </EdgeLabelRenderer>
    </>
  );
}

export const animGraphNodeTypes = {
  "anim.state": AnimStateNode,
};

export const animGraphEdgeTypes = {
  animTransition: AnimTransitionEdge,
  animTransitionBoth: AnimTransitionEdge,
};
