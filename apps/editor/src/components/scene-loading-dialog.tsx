import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
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
};

export function SceneLoadingDialog({
  open,
  progress,
  phase,
}: SceneLoadingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="scene-loading-dialog"
      >
        <DialogHeader>
          <DialogTitle>Loading Scene</DialogTitle>
          <DialogDescription>
            Collecting assets and instantiating models for the viewport.
          </DialogDescription>
        </DialogHeader>
        <Progress value={progress} data-testid="scene-loading-progress">
          <ProgressLabel>{phase}</ProgressLabel>
          <ProgressValue />
        </Progress>
      </DialogContent>
    </Dialog>
  );
}
