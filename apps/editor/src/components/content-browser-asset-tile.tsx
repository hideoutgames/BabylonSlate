import type { IndexedAsset } from "@babylonslate/assets";
import {
  SelectableText,
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
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserAssetTileProps {
  asset: IndexedAsset;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
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
  thumbnailUrl,
  hasCompileError = false,
  typeVisual,
}: ContentBrowserAssetTileProps) {
  const compression = textureCompressionState(asset);
  const thumbAccent = typeColorThumbAccent(typeVisual.colorVar);
  const bind = useLongPressMenu({
    onMenu: (clientX, clientY) => {
      onSelect();
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
          onSelect();
        }}
        onDoubleClick={onOpen}
        {...bind}
      >
        <div
          className="flex aspect-square w-full items-center justify-center"
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
              className="size-10"
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
