import { Dialog } from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import { ProgressDialogContent, ProgressDialogStatus } from "./progress-dialog-parts";

export type ContentBrowserCopyProgress = {
  operation: "copy" | "duplicate";
  /** Name of the item being copied. */
  name: string;
  /** Files copied so far, out of `total`. */
  completed: number;
  total: number;
  canceling: boolean;
};

export type ContentBrowserCopyProgressDialogProps = {
  progress: ContentBrowserCopyProgress | null;
  onCancel: () => void;
};

/** Blocking progress for Copy to Folder and Duplicate, shown like a scene load. */
export function ContentBrowserCopyProgressDialog({ progress, onCancel }: ContentBrowserCopyProgressDialogProps) {
  const total = progress?.total ?? 0;
  const completed = Math.min(progress?.completed ?? 0, total);
  return (
    <Dialog open={progress !== null} onOpenChange={() => {}}>
      <ProgressDialogContent
        overlayClassName="data-closed:pointer-events-none"
        data-testid="content-browser-copy-progress"
      >
        <ProgressDialogStatus
          title={progress?.operation === "duplicate" ? "Duplicating" : "Copying"}
          phase={progress?.canceling ? "Canceling…" : progress?.name ?? ""}
          value={total > 0 ? (completed / total) * 100 : null}
          valueLabel={total > 1 ? `${completed} / ${total}` : null}
          action={(
            <Button
              variant="ghost"
              size="xs"
              className="-mr-1 text-muted-foreground hover:text-foreground"
              disabled={progress?.canceling}
              data-testid="content-browser-copy-cancel"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        />
      </ProgressDialogContent>
    </Dialog>
  );
}
