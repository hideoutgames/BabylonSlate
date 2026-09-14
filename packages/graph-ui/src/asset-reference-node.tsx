import { BaseEdge, Handle, Position, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import {
  TypeVisualIcon,
  resolveTypeVisual,
  TYPE_VISUAL_ICON_TILE_SIZE,
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
  return (
    <div
      className={cn(
        "flex h-36 w-48 flex-col items-center justify-center gap-3 rounded-md border border-border bg-graph-node p-3 text-card-foreground shadow-sm",
        selected && "ring-2 ring-primary",
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
        size={TYPE_VISUAL_ICON_TILE_SIZE}
        className="shrink-0"
      />
      <div className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
        <span className="line-clamp-2 w-full break-all text-sm font-medium">
          {data.title ?? id}
        </span>
        {data.missing ? (
          <span className="text-xs text-muted-foreground">Missing Asset</span>
        ) : null}
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
  const top = Math.min(sourceY, targetY) - 96;
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 64} ${sourceY}, ${sourceX + 64} ${top}, ${sourceX} ${top} L ${targetX} ${top} C ${targetX - 64} ${top}, ${targetX - 64} ${targetY}, ${targetX} ${targetY}`;
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

export const assetReferenceEdgeTypes = { "asset-reference-self": AssetSelfReferenceEdge };
