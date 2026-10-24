import { Button } from "@haptic/ui/components/button";
import { Dialog } from "@haptic/ui/components/dialog";
import { ProgressDialogContent, ProgressDialogStatus } from "./progress-dialog-parts";

export type ImportProgress = {
  /** Dialog title, such as `Importing` or `Converting`. */
  title: string;
  /** What runs now: the file being imported or read, or a batch step. */
  phase: string;
  /** Files finished so far, out of `total`. */
  completed: number;
  total: number;
  /** Fraction of the current file done (0-1), or `null` when the importer cannot tell. */
  fraction: number | null;
  canceling: boolean;
};

export type ImportProgressDialogProps = {
  progress: ImportProgress | null;
  /** Omit for work that cannot be cancelled. */
  onCancel?: () => void;
};

/** Overall percent: whole files done plus the current file's share. */
function importProgressPercent(progress: ImportProgress): number | null {
  if (progress.total <= 0) return null;
  if (progress.fraction === null && progress.total === 1) return null;
  const current = progress.completed < progress.total ? progress.fraction ?? 0 : 0;
  return (Math.min(progress.total, progress.completed + current) / progress.total) * 100;
}

/**
 * Blocking, cancelable progress for imports and HDR conversions, shown like a
 * scene load: per-file count for a batch, percent for a single file.
 */
export function ImportProgressDialog({ progress, onCancel }: ImportProgressDialogProps) {
  const value = progress ? importProgressPercent(progress) : null;
  const total = progress?.total ?? 0;
  const valueLabel = progress === null
    ? null
    : total > 1
      ? `${Math.min(progress.completed + 1, total)} / ${total}`
      : value !== null
        ? `${Math.round(value)}%`
        : null;
  return (
    <Dialog open={progress !== null} onOpenChange={() => {}}>
      <ProgressDialogContent
        overlayClassName="data-closed:pointer-events-none"
        data-testid="importing-overlay"
      >
        <ProgressDialogStatus
          title={progress?.title ?? "Importing"}
          phase={progress?.canceling ? "Canceling…" : progress?.phase ?? ""}
          value={value}
          valueLabel={valueLabel}
          valueLabelProps={{ "data-testid": "importing-count" }}
          progressProps={{ "data-testid": "importing-progress" }}
          action={onCancel ? (
            <Button
              variant="ghost"
              size="xs"
              className="-mr-1 text-muted-foreground hover:text-foreground"
              disabled={progress?.canceling}
              data-testid="importing-cancel"
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : null}
        />
      </ProgressDialogContent>
    </Dialog>
  );
}
