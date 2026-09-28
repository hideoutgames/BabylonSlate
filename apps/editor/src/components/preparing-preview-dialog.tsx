import { Dialog } from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import {
  ProgressDialogContent,
  ProgressDialogFailure,
  ProgressDialogStatus,
} from "./progress-dialog-parts";

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
      <ProgressDialogContent failed={Boolean(error)} data-testid="preparing-preview-dialog">
        {error ? (
          <ProgressDialogFailure
            title="Preview Build Failed"
            description={phase ? `Packaging stopped at ${phase}.` : "The game could not be packaged."}
            actions={(
              <>
                {onCancel ? (
                  <Button type="button" size="sm" variant="outline" data-testid="preparing-preview-cancel" onClick={onCancel}>
                    Close
                  </Button>
                ) : null}
                {onRetry ? (
                  <Button type="button" size="sm" onClick={onRetry}>Retry</Button>
                ) : null}
              </>
            )}
          >
            <SelectableText className="block max-h-40 overflow-y-auto rounded-md bg-destructive/5 px-3 py-2 text-xs ring-1 ring-destructive/20">
              {error}
            </SelectableText>
          </ProgressDialogFailure>
        ) : (
          <ProgressDialogStatus
            title="Preparing Preview"
            phase={phase ?? "Starting"}
            value={phase ? (100 * step) / total : null}
            valueLabel={phase ? `${step} / ${total}` : null}
            valueLabelProps={{ "data-testid": "preparing-preview-count" }}
            progressProps={{ "data-testid": "preparing-preview-progress" }}
            action={canCancel && onCancel ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="-mr-1 text-muted-foreground hover:text-foreground"
                data-testid="preparing-preview-cancel"
                onClick={onCancel}
              >
                Cancel
              </Button>
            ) : null}
          />
        )}
      </ProgressDialogContent>
    </Dialog>
  );
}
