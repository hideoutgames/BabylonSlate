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

export type SceneLoadingDialogProps = {
  open: boolean;
  progress: number;
  phase: SceneViewportLoadPhase;
  failed?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function SceneLoadingDialog({
  open,
  progress,
  phase,
  failed = false,
  onRetry,
  onDismiss,
}: SceneLoadingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="scene-loading-dialog"
      >
        <DialogHeader>
          <DialogTitle>{failed ? "Scene Loading Failed" : "Loading Scene"}</DialogTitle>
          <DialogDescription>
            {failed
              ? "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings."
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
      </DialogContent>
    </Dialog>
  );
}
