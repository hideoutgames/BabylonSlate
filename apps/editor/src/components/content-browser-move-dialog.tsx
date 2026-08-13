import { useMemo, useState } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import {
  SearchInput,
  TreeView,
  TypeVisualIcon,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  contentBrowserMoveDialogTitle,
  filterFolderTreeRows,
  flattenFolderTree,
  isValidSelectionMoveDestination,
  type MoveKind,
} from "../lib/content-browser-helpers";

export interface ContentBrowserMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: MoveKind;
  operation?: "move" | "copy";
  name: string;
  currentFolderPath: string;
  sourcePath: string;
  folderTree: FolderNode | null;
  destinationPath: string;
  onDestinationChange: (path: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  typeVisual?: TypeVisual | null;
  itemCount?: number;
  assetSourcePaths?: readonly string[];
  folderSourcePaths?: readonly string[];
}

export function ContentBrowserMoveDialog({
  open,
  onOpenChange,
  kind,
  operation = "move",
  name,
  currentFolderPath,
  sourcePath,
  folderTree,
  destinationPath,
  onDestinationChange,
  onConfirm,
  busy = false,
  typeVisual = null,
  itemCount,
  assetSourcePaths,
  folderSourcePaths,
}: ContentBrowserMoveDialogProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const resolvedFolderSources = useMemo(
    () => folderSourcePaths ?? (kind === "folder" ? [sourcePath] : []),
    [folderSourcePaths, kind, sourcePath],
  );
  const resolvedAssetSources = useMemo(
    () => assetSourcePaths ?? (kind === "asset" ? [sourcePath] : []),
    [assetSourcePaths, kind, sourcePath],
  );
  const resolvedItemCount =
    itemCount ?? resolvedFolderSources.length + resolvedAssetSources.length;
  const destinationOptions = {
    destinationPath,
    operation,
    assetSourcePaths: resolvedAssetSources,
    folderSourcePaths: resolvedFolderSources,
  };
  const canConfirm = isValidSelectionMoveDestination(destinationOptions);
  const title = contentBrowserMoveDialogTitle({
    operation,
    itemCount: resolvedItemCount,
    folderCount: resolvedFolderSources.length,
    assetCount: resolvedAssetSources.length,
  });

  const nodes = useMemo(() => {
    if (!folderTree) return [];
    const searching = search.trim().length > 0;
    const rows = flattenFolderTree(
      folderTree,
      searching ? new Set() : collapsed,
    );
    return filterFolderTreeRows(rows, search).map((row) => {
      const muted = !isValidSelectionMoveDestination({
        destinationPath: row.path,
        operation,
        assetSourcePaths: resolvedAssetSources,
        folderSourcePaths: resolvedFolderSources,
      });
      return {
        id: row.id,
        label: row.label,
        depth: row.depth,
        hasChildren: row.hasChildren,
        expanded: searching ? true : row.expanded,
        muted,
        icon: <FolderIcon />,
      };
    });
  }, [
    collapsed,
    folderTree,
    operation,
    resolvedAssetSources,
    resolvedFolderSources,
    search,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="content-browser-move-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Choose a destination folder. Currently in {currentFolderPath}.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
          data-testid="content-browser-move-item"
        >
          {resolvedItemCount > 1 ? (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : kind === "folder" ? (
            <FolderIcon className="size-4 shrink-0 text-primary" />
          ) : typeVisual ? (
            <TypeVisualIcon visual={typeVisual} />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {currentFolderPath}
            </p>
          </div>
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search Folders"
          data-testid="content-browser-move-search"
        />
        <div className="h-64 min-h-0 rounded-md border border-border">
          <TreeView
            nodes={nodes}
            selectedId={destinationPath}
            onSelect={(id) => {
              if (
                !isValidSelectionMoveDestination({
                  destinationPath: id,
                  operation,
                  assetSourcePaths: resolvedAssetSources,
                  folderSourcePaths: resolvedFolderSources,
                })
              ) {
                return;
              }
              onDestinationChange(id);
            }}
            onToggleExpanded={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            emptyLabel="No folders"
            data-testid="content-browser-move-tree"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="content-browser-move-confirm"
            disabled={busy || !canConfirm}
            onClick={() => onConfirm()}
          >
            {operation === "copy" ? "Copy" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
