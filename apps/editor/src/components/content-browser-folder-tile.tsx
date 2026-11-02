import { FolderIcon, type LucideIcon } from "lucide-react";
import {
  InlineRenameInput,
  SelectableText,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TYPE_VISUAL_ICON_TILE_STROKE_WIDTH,
} from "@haptic/editor-kit";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@haptic/ui/components/card";
import { cn } from "@haptic/ui/lib/utils";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserFolderTileProps {
  path: string;
  name: string;
  icon?: LucideIcon;
  selected: boolean;
  onOpen: () => void;
  onSelect: (event: {
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  consumeSelectClick?: () => boolean;
  /** Shows the name as a focused inline rename (a folder New Folder just made). */
  renaming?: boolean;
  /** The trimmed new name, or null when cancelled or unchanged. */
  onRenameDone?: (name: string | null) => void;
}

export function ContentBrowserFolderTile({
  path,
  name,
  icon: Icon = FolderIcon,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
  consumeSelectClick,
  renaming = false,
  onRenameDone,
}: ContentBrowserFolderTileProps) {
  const editing = renaming && Boolean(onRenameDone);
  // A text field cannot sit inside a button, so a renaming tile is a plain box.
  const Root = editing ? "div" : "button";
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
      <Root
        {...(editing ? {} : { type: "button" as const })}
        data-testid={`content-folder-${path}`}
        data-folder-path={path}
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
        <div className="flex aspect-square w-full shrink-0 items-center justify-center bg-card">
          <Icon
            size={TYPE_VISUAL_ICON_TILE_SIZE}
            strokeWidth={TYPE_VISUAL_ICON_TILE_STROKE_WIDTH}
            absoluteStrokeWidth
            className="size-10 shrink-0 overflow-visible text-muted-foreground"
            aria-hidden
          />
        </div>
        <CardHeader className="min-h-0 w-full flex-1 content-center gap-0.5 p-1.5">
          {editing ? (
            <InlineRenameInput
              value={name}
              aria-label="Folder Name"
              data-testid={`content-folder-rename-${path}`}
              className="h-5 min-h-5 w-full flex-none text-xs md:text-xs"
              onDone={(next) => onRenameDone?.(next)}
            />
          ) : (
            <CardTitle className="truncate text-xs font-medium">
              <SelectableText>{name}</SelectableText>
            </CardTitle>
          )}
          <CardDescription className="truncate text-[10px]">
            Folder
          </CardDescription>
        </CardHeader>
      </Root>
    </Card>
  );
}
