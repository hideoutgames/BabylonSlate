import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { cn } from "@babylonslate/ui/lib/utils";
import { displayNodeTitle } from "./graph-connect";
import { useGraphEditorContext } from "./graph-editor-context";

type AnimStateData = {
  title?: string;
  entry?: boolean;
  __nodeType?: string;
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
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="anim-state-handle"
      />
      <div className="anim-state-node-title">{title}</div>
      {data.entry === true ? (
        <div className="anim-state-node-entry-mark" aria-hidden>
          Entry
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="anim-state-handle"
      />
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
  selected,
}: EdgeProps) {
  const { onEdgeDoubleClick } = useGraphEditorContext();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn(
            "anim-transition-badge nodrag nopan",
            selected && "anim-transition-badge-selected",
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          data-testid={`anim-transition-badge-${id}`}
          aria-label="Open transition rule"
          onDoubleClick={(event) => {
            event.stopPropagation();
            onEdgeDoubleClick?.(id);
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
};
