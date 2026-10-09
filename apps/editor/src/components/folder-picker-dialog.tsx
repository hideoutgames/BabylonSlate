import { useState } from "react";
import type { FolderNode } from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { FolderTreePicker } from "./folder-tree-picker";

export interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  /** One tree per content root. */
  folderTrees: readonly FolderNode[];
  /** Folders that show muted and cannot be chosen. */
  isDisabled?: (path: string) => boolean;
  onConfirm: (path: string) => void;
  "data-testid"?: string;
}

/** Choose one folder of the registry's content roots. Mount it per use so the choice starts empty. */
export function FolderPickerDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  folderTrees,
  isDisabled,
  onConfirm,
  "data-testid": testId = "folder-picker-dialog",
}: FolderPickerDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <FolderTreePicker
          folderTrees={folderTrees}
          selectedPath={selected}
          onSelect={setSelected}
          isDisabled={isDisabled}
          searchTestId={`${testId}-search`}
          treeTestId={`${testId}-tree`}
        />
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-selection`}>
          Folder: <span className="text-foreground">{selected ?? "None"}</span>
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid={`${testId}-confirm`}
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) onConfirm(selected);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
