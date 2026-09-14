import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";
import type { SceneViewportLoadPhase } from "../lib/scene-viewport-load";
import type { SceneLoadPhase } from "@babylonslate/render";

export type SceneLoadingDialogProps = {
  open: boolean;
  progress: number;
  phase: SceneViewportLoadPhase | SceneLoadPhase;
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
      <DialogContent
        showCloseButton={false}
        data-testid="scene-loading-dialog"
      >
        <DialogHeader>
          <DialogTitle>{rendering
            ? (failed ? "Rendering Update Failed" : "Updating Rendering")
            : (failed ? "Scene Loading Failed" : "Loading Scene")}</DialogTitle>
          <DialogDescription>
            {failed
              ? (phase === "Loading Document"
                ? "The scene document could not be read. Retry, or close this message to return to the current workspace."
                : "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings.")
              : "Preparing scene resources, assets, shaders, and the first frame."}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onDismiss}>Close</Button>
            <Button size="sm" onClick={onRetry}>Retry</Button>
          </DialogFooter>
        ) : <Progress value={progress} data-testid="scene-loading-progress">
          <ProgressLabel>{phase}</ProgressLabel>
          <ProgressValue />
        </Progress>}
        {!failed && onStop ? <DialogFooter><Button variant="outline" size="sm" onClick={onStop}>Stop</Button></DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
