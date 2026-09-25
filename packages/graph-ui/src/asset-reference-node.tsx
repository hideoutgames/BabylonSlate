import {
  BaseEdge,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  TypeVisualIcon,
  humanizePropertyLabel,
  resolveTypeVisual,
} from "@babylonslate/editor-kit";
import { cn } from "@babylonslate/ui/lib/utils";

type AssetReferenceData = {
  title?: string;
  assetType?: string;
  parentClass?: string | null;
  path?: string;
  missing?: boolean;
};

/** Inspection-only asset identity, deliberately separate from scripting nodes. */
export function AssetReferenceNode({
  id,
  data,
  selected,
}: NodeProps<Node<AssetReferenceData>>) {
  const typeLabel = data.missing
    ? "Missing Asset"
    : humanizePropertyLabel((data.assetType ?? "Unresolved").replace(/([a-z])([A-Z])/g, "$1 $2"));
  return (
    <div
      className={cn(
        "asset-reference-node flex h-12 w-56 items-center gap-2.5 rounded-md border border-border bg-graph-node px-2.5 text-card-foreground shadow-sm",
        data.missing && "border-dashed",
      )}
      title={`${data.title ?? id}\n${data.assetType ?? "Unresolved"}\n${data.path ?? id}`}
      data-testid={`asset-reference-node-${id}`}
      data-selected={selected ? "true" : "false"}
    >
      <Handle
        id="used-by"
        type="target"
        position={Position.Left}
        isConnectable={false}
      />
      <TypeVisualIcon
        visual={resolveTypeVisual({
          assetType: data.assetType,
          parentClass: data.parentClass,
        })}
        className="shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium leading-5">
          {data.title ?? id}
        </span>
        <span className="truncate text-xs leading-4 text-muted-foreground">
          {typeLabel}
        </span>
      </div>
      <Handle
        id="uses"
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
    </div>
  );
}

export const assetReferenceNodeTypes = {
  "asset-reference": AssetReferenceNode,
};

/** Route a self-reference above its node so the opaque body cannot hide it. */
function AssetSelfReferenceEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const top = Math.min(sourceY, targetY) - 48;
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 64} ${sourceY}, ${sourceX + 64} ${top}, ${sourceX} ${top} L ${targetX} ${top} C ${targetX - 64} ${top}, ${targetX - 64} ${targetY}, ${targetX} ${targetY}`;
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

/** Two assets that reference each other share one wire with an arrow at each end. */
function AssetMutualReferenceEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <BaseEdge id={id} path={path} markerStart={markerEnd} markerEnd={markerEnd} style={style} />;
}

export const assetReferenceEdgeTypes = {
  "asset-reference-self": AssetSelfReferenceEdge,
  "asset-reference-mutual": AssetMutualReferenceEdge,
};
