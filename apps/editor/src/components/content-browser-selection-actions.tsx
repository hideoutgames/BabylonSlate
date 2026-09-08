import { Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

export function ContentBrowserSelectionActions({
  selectionCount,
  busy,
  onDeselectAll,
  onRequestDelete,
  compact = false,
}: {
  selectionCount: number;
  busy: boolean;
  onDeselectAll: () => void;
  onRequestDelete: () => void;
  compact?: boolean;
}) {
  if (selectionCount <= 0) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={compact ? "touch-icon" : "sm"}
        aria-label="Deselect All"
        data-testid="content-browser-deselect-all"
        disabled={busy}
        onClick={onDeselectAll}
      >
        <XIcon data-icon="inline-start" />
        {!compact ? "Deselect All" : null}
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
