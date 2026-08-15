import { Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

export function ContentBrowserSelectionActions({
  selectionCount,
  busy,
  onDeselectAll,
  onRequestDelete,
}: {
  selectionCount: number;
  busy: boolean;
  onDeselectAll: () => void;
  onRequestDelete: () => void;
}) {
  if (selectionCount <= 0) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="content-browser-deselect-all"
        disabled={busy}
        onClick={onDeselectAll}
      >
        <XIcon data-icon="inline-start" />
        Deselect All
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
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
