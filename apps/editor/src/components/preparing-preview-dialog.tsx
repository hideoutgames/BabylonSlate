import { PackageIcon, TriangleAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import { Progress } from "@babylonslate/ui/components/progress";
import { ProgressDialogHeader, ProgressStepList } from "./progress-dialog-parts";

export const PREVIEW_PREPARE_PHASES = [
  "Saving",
  "Collecting Assets",
  "Compiling",
  "Writing Pack",
  "Launching",
] as const;

export type PreviewPreparePhase = (typeof PREVIEW_PREPARE_PHASES)[number];

const PREVIEW_STEPS = PREVIEW_PREPARE_PHASES.map((phase) => ({
  key: phase,
  label: phase,
}));

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
  const showCancel = Boolean((canCancel || error) && onCancel);
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        data-testid="preparing-preview-dialog"
      >
        <ProgressDialogHeader
          icon={error ? TriangleAlertIcon : PackageIcon}
          failed={Boolean(error)}
          title={error ? "Preview Build Failed" : "Preparing Preview"}
          description={error
            ? (phase ? `Packaging stopped at ${phase}.` : "The game could not be packaged.")
            : "Packaging the game for Preview Build."}
          aside={!error && phase ? (
            <span
              data-testid="preparing-preview-count"
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums"
            >
              {step} / {total}
            </span>
          ) : null}
        />
        {error ? (
          <SelectableText className="block max-h-40 overflow-y-auto rounded-md bg-destructive/5 px-3 py-2 text-sm ring-1 ring-destructive/20">
            {error}
          </SelectableText>
        ) : phase ? (
          <Progress
            value={(100 * step) / total}
            aria-label={`${phase}, step ${step} of ${total}`}
            data-testid="preparing-preview-progress"
          >
            <ProgressStepList steps={PREVIEW_STEPS} current={step - 1} className="pl-2.5" />
          </Progress>
        ) : null}
        {showCancel || !error ? (
          <DialogFooter className="justify-between">
            {!error ? (
              <span className="text-xs text-muted-foreground">
                Editor viewports pause until the player launches.
              </span>
            ) : <span />}
            {showCancel ? (
              <div className="ml-auto flex gap-2">
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
              </div>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
