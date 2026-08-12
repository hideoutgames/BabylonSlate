import type { DragEvent } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import { SelectableText, useHoldDragMenu } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  ASSET_DRAG_MIME,
  ASSETS_ROOT,
  FOLDER_DRAG_MIME,
  folderDropTargetFromPoint,
  guidFromAssetDragData,
  isFolderTreeRoot,
} from "../lib/content-browser-helpers";

export interface ContentBrowserFolderTreeProps {
  node: FolderNode;
  selectedPath: string;
  dropPath: string | null;
  rootPath?: string;
  depth?: number;
  onSelect: (path: string) => void;
  onRequestDelete: (path: string) => void;
  onDropAsset: (guid: string, folderPath: string) => void;
  onDropFolder: (fromPath: string, toPath: string) => void;
  onDropPathChange: (path: string | null) => void;
}

export function ContentBrowserFolderTree({
  node,
  selectedPath,
  dropPath,
  rootPath = ASSETS_ROOT,
  depth = 0,
  onSelect,
  onRequestDelete,
  onDropAsset,
  onDropFolder,
  onDropPathChange,
}: ContentBrowserFolderTreeProps) {
  const selected = node.path === selectedPath;
  const dropTarget = dropPath === node.path;
  const isRoot = isFolderTreeRoot(node.path, rootPath);

  const { armed, dragging, bind } = useHoldDragMenu({
    enabled: !isRoot,
    onDragMove: (clientX, clientY) => {
      onDropPathChange(folderDropTargetFromPoint(clientX, clientY));
    },
    onDrop: (clientX, clientY) => {
      const target = folderDropTargetFromPoint(clientX, clientY);
      if (target) onDropFolder(node.path, target);
      onDropPathChange(null);
    },
    onMenu: () => {
      onSelect(node.path);
      onRequestDelete(node.path);
    },
  });

  const acceptDrop = (event: DragEvent) => {
    if (
      event.dataTransfer.types.includes(ASSET_DRAG_MIME) ||
      event.dataTransfer.types.includes(FOLDER_DRAG_MIME)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      onDropPathChange(node.path);
    }
  };

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant={selected ? "secondary" : "ghost"}
        size="sm"
        draggable={!isRoot}
        data-testid={`folder-node-${node.path}`}
        data-folder-path={node.path}
        className={cn(
          "w-full justify-start rounded-md border-l-2 px-2 text-left",
          selected ? "border-l-primary" : "border-l-transparent",
          (dropTarget || armed || dragging) && "bg-accent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(node.path);
          if (!isRoot) onRequestDelete(node.path);
        }}
        onDragStart={(event) => {
          if (isRoot) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData(FOLDER_DRAG_MIME, node.path);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={acceptDrop}
        onDrop={(event) => {
          event.preventDefault();
          const assetGuid = guidFromAssetDragData(
            event.dataTransfer.getData(ASSET_DRAG_MIME),
          );
          if (assetGuid) {
            onDropAsset(assetGuid, node.path);
            onDropPathChange(null);
            return;
          }
          const fromPath = event.dataTransfer.getData(FOLDER_DRAG_MIME);
          if (fromPath) onDropFolder(fromPath, node.path);
          onDropPathChange(null);
        }}
        {...bind}
      >
        <FolderIcon data-icon="inline-start" />
        <SelectableText className="truncate">{node.name}</SelectableText>
      </Button>
      {node.children.map((child) => (
        <ContentBrowserFolderTree
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          dropPath={dropPath}
          rootPath={rootPath}
          depth={depth + 1}
          onSelect={onSelect}
          onRequestDelete={onRequestDelete}
          onDropAsset={onDropAsset}
          onDropFolder={onDropFolder}
          onDropPathChange={onDropPathChange}
        />
      ))}
    </div>
  );
}
