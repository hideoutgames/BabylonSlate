import { Dialog } from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import type { SceneViewportLoadPhase } from "../lib/scene-viewport-load";
import type { SceneLoadPhase } from "@babylonslate/render";
import {
  ProgressDialogContent,
  ProgressDialogFailure,
  ProgressDialogStatus,
} from "./progress-dialog-parts";

type SceneLoadingPhase = SceneViewportLoadPhase | SceneLoadPhase;

export type SceneLoadingDialogProps = {
  open: boolean;
  /** Percent complete, or `null` when the phase has no measurable progress (document reads). */
  progress: number | null;
  phase: SceneLoadingPhase;
  onStop?: () => void;
  failed?: boolean;
  rendering?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function SceneLoadingDialog({
  open,
  progress,
  phase,
  failed = false,
  rendering = false,
  onRetry,
  onDismiss,
  onStop,
}: SceneLoadingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <ProgressDialogContent
        failed={failed}
        overlayClassName="data-closed:pointer-events-none"
        data-testid="scene-loading-dialog"
      >
        {failed ? (
          <ProgressDialogFailure
            title={rendering ? "Rendering Update Failed" : "Scene Loading Failed"}
            description={phase === "Loading Document"
              ? "The scene document could not be read. Retry, or close this message to return to the current workspace."
              : "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings."}
            actions={(
              <>
                <Button variant="outline" size="sm" onClick={onDismiss}>Close</Button>
                <Button size="sm" onClick={onRetry}>Retry</Button>
              </>
            )}
          />
        ) : (
          <ProgressDialogStatus
            title={rendering ? "Updating Rendering" : "Loading Scene"}
            phase={phase}
            value={progress}
            valueLabel={progress === null ? null : `${Math.round(progress)}%`}
            progressProps={{ "data-testid": "scene-loading-progress" }}
            action={onStop ? (
              <Button variant="ghost" size="xs" className="-mr-1 text-muted-foreground hover:text-foreground" onClick={onStop}>Stop</Button>
            ) : null}
          />
        )}
      </ProgressDialogContent>
    </Dialog>
  );
}
