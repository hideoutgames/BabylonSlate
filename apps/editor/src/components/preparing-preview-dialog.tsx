import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";

export const PREVIEW_PREPARE_PHASES = [
  "Saving",
  "Collecting Assets",
  "Compiling",
  "Writing Pack",
  "Launching",
] as const;

export type PreviewPreparePhase = (typeof PREVIEW_PREPARE_PHASES)[number];

export type PreparingPreviewDialogProps = {
  open: boolean;
  phase: PreviewPreparePhase | null;
  error?: string | null;
  onCancel?: () => void;
  onRetry?: () => void;
  canCancel?: boolean;
};

export function PreparingPreviewDialog({
  open,
  phase,
  error = null,
  onCancel,
  onRetry,
  canCancel = true,
}: PreparingPreviewDialogProps) {
  const step = phase ? PREVIEW_PREPARE_PHASES.indexOf(phase) + 1 : 0;
  const total = PREVIEW_PREPARE_PHASES.length;
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="preparing-preview-dialog"
      >
        <DialogHeader>
          <DialogTitle>{error ? "Preview Build Failed" : "Preparing Preview"}</DialogTitle>
          <DialogDescription>
            {error ? (
              <SelectableText>{error}</SelectableText>
            ) : (
              "Packaging the game for Preview Build. Editor viewports freeze until the player launches."
            )}
          </DialogDescription>
        </DialogHeader>
        {!error && phase ? (
          <>
            <p
              data-testid="preparing-preview-count"
              className="text-sm text-muted-foreground tabular-nums"
            >
              {step} / {total}
            </p>
            <Progress value={(100 * step) / total} data-testid="preparing-preview-progress">
              <ProgressLabel>{phase}</ProgressLabel>
              <ProgressValue />
            </Progress>
          </>
        ) : null}
        {(canCancel || error) && onCancel ? (
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="preparing-preview-cancel"
              onClick={onCancel}
            >
              {error ? "Close" : "Cancel"}
            </Button>
            {error && onRetry ? (
              <Button type="button" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
