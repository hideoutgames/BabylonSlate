import type { DragEvent } from "react";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  SelectableText,
  TypeVisualIcon,
  useHoldDragMenu,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  ASSET_DRAG_MIME,
  ASSETS_ROOT,
  assetDragPayload,
  compressionBadgeLabel,
  displayAssetTitle,
  folderDropTargetFromPoint,
  guidFromAssetDragData,
  textureCompressionState,
} from "../lib/content-browser-helpers";

export interface ContentBrowserAssetTileProps {
  asset: IndexedAsset;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  onArmedDrag: (guid: string) => void;
  onDropAsset: (guid: string, folderPath: string) => void;
  onDropPathChange?: (path: string | null) => void;
  thumbnailUrl: string | null;
  hasCompileError?: boolean;
  typeVisual: TypeVisual;
}

export function ContentBrowserAssetTile({
  asset,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
  onArmedDrag,
  onDropAsset,
  onDropPathChange,
  thumbnailUrl,
  hasCompileError = false,
  typeVisual,
}: ContentBrowserAssetTileProps) {
  const compression = textureCompressionState(asset);
  const folderPath = asset.path.includes("/")
    ? asset.path.slice(0, asset.path.lastIndexOf("/"))
    : ASSETS_ROOT;

  const { armed, dragging, bind } = useHoldDragMenu({
    onArm: () => onArmedDrag(asset.header.guid),
    onDragMove: (clientX, clientY) => {
      onDropPathChange?.(folderDropTargetFromPoint(clientX, clientY));
    },
    onDrop: (clientX, clientY) => {
      const dropFolder = folderDropTargetFromPoint(clientX, clientY);
      if (dropFolder) onDropAsset(asset.header.guid, dropFolder);
      onDropPathChange?.(null);
    },
    onMenu: onLongPressMenu,
  });

  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(ASSET_DRAG_MIME, assetDragPayload(asset));
    event.dataTransfer.effectAllowed = "copyMove";
  };

  return (
    <Card
      size="sm"
      className={cn(
        "relative w-full gap-0 overflow-hidden py-0",
        selected || armed ? "border-primary ring-1 ring-primary" : "",
        dragging ? "opacity-60" : "",
      )}
      data-asset-folder={folderPath}
    >
      <button
        type="button"
        draggable
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="flex w-full flex-col text-left hover:bg-accent/50"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onDoubleClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
          onLongPressMenu(event.clientX, event.clientY);
        }}
        onDragStart={onDragStart}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(ASSET_DRAG_MIME)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const guid = guidFromAssetDragData(
            event.dataTransfer.getData(ASSET_DRAG_MIME),
          );
          if (guid && guid !== asset.header.guid) {
            onDropAsset(guid, folderPath);
          }
        }}
        {...bind}
      >
        <div className="aspect-square w-full bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              data-testid={`content-item-thumb-${asset.header.guid}`}
              className="size-full object-cover"
            />
          ) : (
            <TypeVisualIcon
              visual={typeVisual}
              className="size-full p-4"
              data-testid={`content-item-type-icon-${asset.header.guid}`}
            />
          )}
        </div>
        <CardHeader className="gap-0.5 p-1.5">
          <CardTitle className="truncate text-xs font-medium">
            <SelectableText>{displayAssetTitle(asset.header.name)}</SelectableText>
          </CardTitle>
          <CardDescription className="truncate text-[10px]">
            {asset.header.type}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1 px-1.5 pb-1.5">
          {compression ? (
            <Badge variant="secondary" className="w-fit text-[10px]">
              {compressionBadgeLabel(compression)}
            </Badge>
          ) : null}
          {hasCompileError ? (
            <Badge
              variant="destructive"
              className="w-fit text-[10px]"
              data-testid={`compile-error-overlay-${asset.header.guid}`}
            >
              Compile error
            </Badge>
          ) : null}
          <span data-lock-slot className="hidden" aria-hidden />
        </CardContent>
      </button>
    </Card>
  );
}
