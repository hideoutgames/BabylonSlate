import type { IndexedAsset } from "@babylonslate/assets";
import {
  SelectableText,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  compressionBadgeLabel,
  displayAssetTitle,
  textureCompressionState,
} from "../lib/content-browser-helpers";
import { LockIcon } from "lucide-react";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserAssetTileProps {
  asset: IndexedAsset;
  selected: boolean;
  onOpen: () => void;
  onSelect: (event: {
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  consumeSelectClick?: () => boolean;
  thumbnailUrl: string | null;
  hasCompileError?: boolean;
  typeVisual: TypeVisual;
  sourceControlEnabled?: boolean;
  lockState?: "mine" | "theirs" | null;
  lockOwnerName?: string;
}

export function ContentBrowserAssetTile({
  asset,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
  consumeSelectClick,
  thumbnailUrl,
  hasCompileError = false,
  typeVisual,
  sourceControlEnabled = false,
  lockState = null,
  lockOwnerName,
}: ContentBrowserAssetTileProps) {
  const compression = textureCompressionState(asset);
  const thumbAccent = typeColorThumbAccent(typeVisual.colorVar);
  const bind = useLongPressMenu({
    onMenu: (clientX, clientY) => {
      onLongPressMenu(clientX, clientY);
    },
  });

  return (
    <Card
      size="sm"
      className={cn(
        "content-library-tile relative w-full gap-0 overflow-hidden py-0",
        selected ? "border-primary ring-1 ring-primary" : "",
      )}
      data-selected={selected ? "true" : "false"}
    >
      <Button
        type="button"
        variant="ghost"
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="content-library-tile-button flex h-auto w-full flex-col items-stretch gap-0 rounded-none border-0 p-0 text-left"
        onClick={(event) => {
          event.stopPropagation();
          if (event.button !== 0) return;
          if (consumeSelectClick?.()) return;
          onSelect(event);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        {...bind}
      >
        <div className="content-library-tile-preview relative aspect-square w-full">
          <div
            className="content-library-tile-accent absolute inset-0.5 flex items-center justify-center overflow-hidden bg-card"
            style={thumbAccent}
          >
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
                size={TYPE_VISUAL_ICON_TILE_SIZE}
                data-testid={`content-item-type-icon-${asset.header.guid}`}
              />
            )}
          </div>
        </div>
        <CardHeader className="content-library-tile-identity gap-0.5 p-1.5">
          <CardTitle className="truncate text-xs font-medium">
            <SelectableText>{displayAssetTitle(asset.header.name)}</SelectableText>
          </CardTitle>
          <CardDescription className="truncate text-[10px]">
            {asset.header.type}
          </CardDescription>
        </CardHeader>
        <CardContent className="content-library-tile-status flex flex-wrap gap-1 px-1.5 pb-1.5">
          {compression ? (
            <Badge
              variant="secondary"
              className="w-fit text-[10px]"
              data-testid={`texture-compression-${asset.header.guid}`}
            >
              {compressionBadgeLabel(compression)}
            </Badge>
          ) : null}
          {hasCompileError ? (
            <Badge
              variant="destructive"
              className="w-fit text-[10px]"
              data-testid={`compile-error-overlay-${asset.header.guid}`}
            >
              Compile Error
            </Badge>
          ) : null}
          {sourceControlEnabled ? (
            <span
              data-lock-slot
              data-lock-state={lockState ?? undefined}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
            >
              {lockState ? <LockIcon className="size-3" aria-hidden /> : null}
              {lockState === "theirs" && lockOwnerName ? (
                <SelectableText>{lockOwnerName}</SelectableText>
              ) : null}
            </span>
          ) : (
            <span data-lock-slot className="hidden" aria-hidden />
          )}
        </CardContent>
      </Button>
    </Card>
  );
}
