import { useCallback, useMemo } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import { TypeVisualIcon, type TypeVisual } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  contentBrowserMoveDialogTitle,
  isValidSelectionMoveDestination,
  type MoveKind,
} from "../lib/content-browser-helpers";
import { FolderTreePicker } from "./folder-tree-picker";

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
  error?: string | null;
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
  error = null,
  typeVisual = null,
  itemCount,
  assetSourcePaths,
  folderSourcePaths,
}: ContentBrowserMoveDialogProps) {
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

  const folderTrees = useMemo(() => (folderTree ? [folderTree] : []), [folderTree]);
  const isIllegalDestination = useCallback(
    (path: string) =>
      !isValidSelectionMoveDestination({
        destinationPath: path,
        operation,
        assetSourcePaths: resolvedAssetSources,
        folderSourcePaths: resolvedFolderSources,
      }),
    [operation, resolvedAssetSources, resolvedFolderSources],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="content-browser-move-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
        <FolderTreePicker
          folderTrees={folderTrees}
          selectedPath={destinationPath}
          onSelect={onDestinationChange}
          isDisabled={isIllegalDestination}
          searchTestId="content-browser-move-search"
          treeTestId="content-browser-move-tree"
        />
        <p className="text-sm text-muted-foreground" data-testid="content-browser-move-destination">
          Destination: <span className="text-foreground">{destinationPath}</span>
        </p>
        {!canConfirm ? (
          <p className="text-xs text-muted-foreground">
            Choose a different folder. Items cannot move to their current folder or inside themselves.
          </p>
        ) : null}
        {error ? <Alert variant="destructive"><AlertTitle>Could Not {operation === "copy" ? "Copy" : "Move"} Items</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
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
            {busy ? operation === "copy" ? "Copying…" : "Moving…" : operation === "copy" ? "Copy" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
