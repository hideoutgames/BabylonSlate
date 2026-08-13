import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import { ASSETS_ROOT, isFolderTreeRoot } from "../lib/content-browser-helpers";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export interface ContentBrowserFolderTreeProps {
  node: FolderNode;
  selectedPath: string;
  rootPath?: string;
  depth?: number;
  onSelect: (path: string) => void;
  onContextMenu: (path: string, clientX: number, clientY: number) => void;
}

export function ContentBrowserFolderTree({
  node,
  selectedPath,
  rootPath = ASSETS_ROOT,
  depth = 0,
  onSelect,
  onContextMenu,
}: ContentBrowserFolderTreeProps) {
  const selected = node.path === selectedPath;
  const isRoot = isFolderTreeRoot(node.path, rootPath);
  const bind = useLongPressMenu({
    enabled: !isRoot,
    onMenu: (clientX, clientY) => {
      onSelect(node.path);
      onContextMenu(node.path, clientX, clientY);
    },
  });

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant={selected ? "secondary" : "ghost"}
        size="sm"
        data-testid={`folder-node-${node.path}`}
        data-folder-path={node.path}
        className={cn(
          "w-full justify-start rounded-md border-l-2 px-2 text-left",
          selected ? "border-l-primary" : "border-l-transparent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (isRoot) return;
          bind.onContextMenu(event);
        }}
        onPointerDown={bind.onPointerDown}
        onPointerMove={bind.onPointerMove}
        onPointerUp={bind.onPointerUp}
        onPointerCancel={bind.onPointerCancel}
      >
        <FolderIcon data-icon="inline-start" />
        <SelectableText className="truncate">{node.name}</SelectableText>
      </Button>
      {node.children.map((child) => (
        <ContentBrowserFolderTree
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          rootPath={rootPath}
          depth={depth + 1}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}
