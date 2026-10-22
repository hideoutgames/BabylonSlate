import { useCallback, useMemo, useRef } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@haptic/assets";
import { TypeVisualIcon, type TypeVisual } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import {
  contentBrowserMoveDialogTitle,
  contentBrowserSelectionMoves,
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
  folderTree: FolderNode | null;
  destinationPath: string;
  onDestinationChange: (path: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
  typeVisual?: TypeVisual | null;
  itemCount?: number;
  /** Selected asset files and (outermost) folders. */
  assetPaths: readonly string[];
  folderPaths: readonly string[];
  /** Content root prefixes; items outside the destination's root stay put. */
  rootPaths?: readonly string[];
  /** Existing asset and folder paths, so a Move never lands on a taken name. */
  existingPaths?: ReadonlySet<string>;
}

export function ContentBrowserMoveDialog({
  open,
  onOpenChange,
  kind,
  operation = "move",
  name,
  currentFolderPath,
  folderTree,
  destinationPath,
  onDestinationChange,
  onConfirm,
  busy = false,
  error = null,
  typeVisual = null,
  itemCount,
  assetPaths,
  folderPaths,
  rootPaths,
  existingPaths,
}: ContentBrowserMoveDialogProps) {
  const resolvedItemCount = itemCount ?? folderPaths.length + assetPaths.length;
  const destinationError = useCallback(
    (path: string) =>
      contentBrowserSelectionMoves({
        destinationPath: path,
        operation,
        assetPaths,
        folderPaths,
        rootPaths,
        existingPaths,
      }).error,
    [assetPaths, existingPaths, folderPaths, operation, rootPaths],
  );
  const destinationProblem = destinationError(destinationPath);
  const title = contentBrowserMoveDialogTitle({
    operation,
    itemCount: resolvedItemCount,
    folderCount: folderPaths.length,
    assetCount: assetPaths.length,
  });

  const folderTrees = useMemo(() => (folderTree ? [folderTree] : []), [folderTree]);
  const isIllegalDestination = useCallback(
    (path: string) => destinationError(path) !== null,
    [destinationError],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="content-browser-move-dialog"
        // Touch opens keyboard-free so the folder tree pans at once (FolderPickerDialog).
        initialFocus={(interaction) => (interaction === "keyboard" ? searchRef.current : bodyRef.current)}
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
          searchRef={searchRef}
          bodyRef={bodyRef}
        />
        <p className="text-sm text-muted-foreground" data-testid="content-browser-move-destination">
          Destination: <span className="text-foreground">{destinationPath}</span>
        </p>
        {destinationProblem ? (
          <p className="text-xs text-muted-foreground" data-testid="content-browser-move-problem">
            Choose a different folder. {destinationProblem}
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
            disabled={busy || destinationProblem !== null}
            onClick={() => onConfirm()}
          >
            {busy ? operation === "copy" ? "Copying…" : "Moving…" : operation === "copy" ? "Copy" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
