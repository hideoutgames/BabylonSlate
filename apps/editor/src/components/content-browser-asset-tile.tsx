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
  const lockLabel =
    lockState === "mine"
      ? "Locked By You"
      : `Locked By ${lockOwnerName || "Another User"}`;
  const bind = useLongPressMenu({
    onMenu: (clientX, clientY) => {
      onLongPressMenu(clientX, clientY);
    },
  });

  return (
    <Card
      size="sm"
      className={cn(
        "relative h-full w-full gap-0 overflow-hidden py-0",
        selected ? "border-primary ring-1 ring-primary" : "",
      )}
    >
      <button
        type="button"
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="flex h-full w-full flex-col text-left hover:bg-accent/50"
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
        <div className="relative aspect-square w-full shrink-0">
          <div
            className="absolute inset-0.5 flex items-center justify-center overflow-hidden bg-card"
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
            <div className="absolute inset-x-1 top-1 flex items-start gap-1">
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                {compression ? (
                  <Badge
                    variant="secondary"
                    className="max-w-full text-[10px]"
                    title={compressionBadgeLabel(compression)}
                    data-testid={`texture-compression-${asset.header.guid}`}
                  >
                    <span className="truncate">
                      {compressionBadgeLabel(compression)}
                    </span>
                  </Badge>
                ) : null}
                {hasCompileError ? (
                  <Badge
                    variant="destructive"
                    className="max-w-full text-[10px]"
                    title="Compile Error"
                    data-testid={`compile-error-overlay-${asset.header.guid}`}
                  >
                    <span className="truncate">Compile Error</span>
                  </Badge>
                ) : null}
              </div>
              {sourceControlEnabled && lockState ? (
                <Badge
                  variant="secondary"
                  data-lock-slot
                  data-lock-state={lockState}
                  className="max-w-14 gap-1 px-1 text-[10px]"
                  title={lockLabel}
                  role="img"
                  aria-label={lockLabel}
                >
                  <LockIcon className="shrink-0" aria-hidden />
                  {lockState === "theirs" && lockOwnerName ? (
                    <SelectableText className="truncate">
                      {lockOwnerName}
                    </SelectableText>
                  ) : null}
                </Badge>
              ) : (
                <span data-lock-slot className="hidden" aria-hidden />
              )}
            </div>
          </div>
        </div>
        <CardHeader className="min-h-0 w-full flex-1 content-center gap-0.5 p-1.5">
          <CardTitle className="truncate text-xs font-medium">
            <SelectableText>
              {displayAssetTitle(asset.header.name)}
            </SelectableText>
          </CardTitle>
          <CardDescription className="truncate text-[10px]">
            {asset.header.type}
          </CardDescription>
        </CardHeader>
      </button>
    </Card>
  );
}
