import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
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
