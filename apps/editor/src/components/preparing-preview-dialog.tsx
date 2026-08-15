import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";

export const PREVIEW_PREPARE_PHASES = [
  "Saving",
  "Compiling",
  "Collecting Assets",
  "Writing Pack",
  "Launching",
] as const;

export type PreviewPreparePhase = (typeof PREVIEW_PREPARE_PHASES)[number];

export type PreparingPreviewDialogProps = {
  open: boolean;
  phase: PreviewPreparePhase;
  onCancel?: () => void;
  canCancel?: boolean;
};

export function PreparingPreviewDialog({
  open,
  phase,
  onCancel,
  canCancel = true,
}: PreparingPreviewDialogProps) {
  const step = Math.max(1, PREVIEW_PREPARE_PHASES.indexOf(phase) + 1);
  const total = PREVIEW_PREPARE_PHASES.length;
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="preparing-preview-dialog"
      >
        <DialogHeader>
          <DialogTitle>Preparing Preview</DialogTitle>
          <DialogDescription>
            Packaging the game for Preview Build. Editor viewports freeze until
            the player launches.
          </DialogDescription>
        </DialogHeader>
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
        {canCancel && onCancel ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-testid="preparing-preview-cancel"
              onClick={onCancel}
            >
              Cancel
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
