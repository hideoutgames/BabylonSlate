import { ArrowUpRightIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

export function ContentBrowserSelectionActions({
  selectionCount,
  busy,
  onOpen,
  onDeselectAll,
  onRequestDelete,
  compact = false,
}: {
  selectionCount: number;
  busy: boolean;
  /** Shown when the selection is one openable asset or folder. */
  onOpen?: () => void;
  onDeselectAll: () => void;
  onRequestDelete: () => void;
  compact?: boolean;
}) {
  if (selectionCount <= 0) return null;
  return (
    <>
      {onOpen ? (
        <Button
          type="button"
          variant="outline"
          size={compact ? "touch" : "sm"}
          data-testid="content-browser-open-selected"
          disabled={busy}
          onClick={onOpen}
        >
          <ArrowUpRightIcon data-icon="inline-start" />
          Open
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size={compact ? "touch-icon" : "sm"}
        aria-label="Deselect"
        data-testid="content-browser-deselect-all"
        disabled={busy}
        onClick={onDeselectAll}
      >
        <XIcon data-icon="inline-start" />
        {!compact ? "Deselect" : null}
      </Button>
      <Button
        type="button"
        variant="outline"
        size={compact ? "touch" : "sm"}
        data-testid="content-browser-delete-selected"
        disabled={busy}
        onClick={onRequestDelete}
      >
        <Trash2Icon data-icon="inline-start" />
        Delete ({selectionCount})
      </Button>
    </>
  );
}
