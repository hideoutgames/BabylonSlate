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
import { Repeat2Icon } from "lucide-react";
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
  loop?: boolean;
  /** Host-supplied clip summary shown under the title. */
  clipLabel?: string;
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
        <span key={side} className="contents">
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
      {typeof data.clipLabel === "string" ? (
        <div
          className={cn(
            "anim-state-node-clip",
            data.clipLabel === "No Clip" && "anim-state-node-clip-empty",
          )}
          data-testid={`anim-state-node-clip-${id}`}
        >
          <span className="truncate">{data.clipLabel}</span>
          {data.loop !== false ? (
            <Repeat2Icon aria-label="Loops" className="anim-state-node-loop" />
          ) : null}
        </div>
      ) : null}
      {data.entry === true ? (
        <div className="anim-state-node-entry-mark">Entry</div>
      ) : null}
    </div>
  );
}

/** Side plates stick out of the card; pull wire ends back so they meet the border. */
const SOURCE_PLATE_OVERHANG = 10;
const TARGET_PLATE_OVERHANG = 2;

function insetTowardNode(
  x: number,
  y: number,
  position: Position,
  inset: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: x + inset, y };
    case Position.Right:
      return { x: x - inset, y };
    case Position.Top:
      return { x, y: y + inset };
    case Position.Bottom:
      return { x, y: y - inset };
    default:
      return { x, y };
  }
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
  const source = insetTowardNode(sourceX, sourceY, sourcePosition, SOURCE_PLATE_OVERHANG);
  const target = insetTowardNode(targetX, targetY, targetPosition, TARGET_PLATE_OVERHANG);
  const { path: edgePath, labelX, labelY, angle } = animTransitionPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition,
    targetX: target.x,
    targetY: target.y,
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
