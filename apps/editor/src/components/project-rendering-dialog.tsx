import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@haptic/ui/components/dialog";
import { Button } from "@haptic/ui/components/button";
import { Progress, ProgressLabel } from "@haptic/ui/components/progress";
import type { ProjectEngineState } from "../lib/project-engine";

export function ProjectRenderingDialog({ state, retrying = false, onRetry, onDismiss }: {
  state: ProjectEngineState;
  /** A Retry is waiting for a stopping game to release the old Engine. */
  retrying?: boolean;
  onRetry(): void;
  onDismiss(): void;
}) {
  const failed = state.phase === "failed";
  return <Dialog open onOpenChange={() => {}}>
    <DialogContent showCloseButton={false} data-testid="project-rendering-dialog">
      <DialogHeader>
        <DialogTitle>{failed ? "Rendering Update Failed" : "Updating Rendering"}</DialogTitle>
        <DialogDescription>
          {failed ? (state.error instanceof Error ? state.error.message : "Rendering could not start. Retry or return to settings.")
            : "Preparing rendering for the Scene, previews, and Play. Open documents and unsaved edits are retained."}
        </DialogDescription>
      </DialogHeader>
      {failed ? <DialogFooter>
        <Button size="sm" variant="outline" onClick={onDismiss}>Close</Button>
        <Button size="sm" disabled={state.retryable === false || retrying} onClick={onRetry}>Retry</Button>
      </DialogFooter> : <Progress value={state.phase === "preparing" ? 10 : 50}>
        <ProgressLabel>{state.phase === "preparing" ? "Preparing Rendering" : "Starting Renderer"}</ProgressLabel>
      </Progress>}
    </DialogContent>
  </Dialog>;
}
