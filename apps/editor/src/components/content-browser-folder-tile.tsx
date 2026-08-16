import { FolderIcon } from "lucide-react";
import {
  SelectableText,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TYPE_VISUAL_ICON_TILE_STROKE_WIDTH,
} from "@babylonslate/editor-kit";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { cn } from "@babylonslate/ui/lib/utils";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserFolderTileProps {
  path: string;
  name: string;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  consumeSelectClick?: () => boolean;
}

export function ContentBrowserFolderTile({
  path,
  name,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
  consumeSelectClick,
}: ContentBrowserFolderTileProps) {
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
        data-testid={`content-folder-${path}`}
        data-folder-path={path}
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
        <div className="flex aspect-square w-full items-center justify-center bg-card">
          <FolderIcon
            size={TYPE_VISUAL_ICON_TILE_SIZE}
            strokeWidth={TYPE_VISUAL_ICON_TILE_STROKE_WIDTH}
            absoluteStrokeWidth
            className="size-10 shrink-0 overflow-visible text-muted-foreground"
            aria-hidden
          />
        </div>
        <CardHeader className="gap-0.5 p-1.5">
          <CardTitle className="truncate text-xs font-medium">
            <SelectableText>{name}</SelectableText>
          </CardTitle>
          <CardDescription className="truncate text-[10px]">
            Folder
          </CardDescription>
        </CardHeader>
      </button>
    </Card>
  );
}
