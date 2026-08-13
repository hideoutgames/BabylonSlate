import { FolderIcon } from "lucide-react";
import {
  SelectableText,
} from "@babylonslate/editor-kit";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { assetColorVar, typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { cn } from "@babylonslate/ui/lib/utils";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserFolderTileProps {
  path: string;
  name: string;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
}

export function ContentBrowserFolderTile({
  path,
  name,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
}: ContentBrowserFolderTileProps) {
  const colorVar = assetColorVar("folder");
  const thumbAccent = typeColorThumbAccent(colorVar);
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
        data-testid={`content-folder-${path}`}
        data-folder-path={path}
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
          <FolderIcon
            className="size-10"
            style={{ color: colorVar }}
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
