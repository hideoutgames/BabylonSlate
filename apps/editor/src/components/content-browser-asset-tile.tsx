import type { IndexedAsset } from "@babylonslate/assets";
import {
  SelectableText,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
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
  onSelect: () => void;
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
        "relative w-full gap-0 overflow-hidden py-0",
        selected ? "border-primary ring-1 ring-primary" : "",
      )}
    >
      <button
        type="button"
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="flex w-full flex-col text-left hover:bg-accent/50"
        onClick={(event) => {
          event.stopPropagation();
          if (event.button !== 0) return;
          if (consumeSelectClick?.()) return;
          onSelect();
        }}
        onDoubleClick={onOpen}
        {...bind}
      >
        <div className="aspect-square w-full overflow-hidden rounded-t-xl p-0.5">
          <div
            className="flex size-full items-center justify-center bg-card"
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
              Compile error
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
      </button>
    </Card>
  );
}
