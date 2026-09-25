import {
  BoxIcon,
  LoaderCircleIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";
import type { SceneViewportLoadPhase } from "../lib/scene-viewport-load";
import type { SceneLoadPhase } from "@babylonslate/render";
import { ProgressDialogHeader } from "./progress-dialog-parts";

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
        className="sm:max-w-md"
        data-testid="scene-loading-dialog"
      >
        <ProgressDialogHeader
          icon={failed ? TriangleAlertIcon : rendering ? SparklesIcon : BoxIcon}
          failed={failed}
          title={rendering
            ? (failed ? "Rendering Update Failed" : "Updating Rendering")
            : (failed ? "Scene Loading Failed" : "Loading Scene")}
          description={failed
            ? (phase === "Loading Document"
              ? "The scene document could not be read. Retry, or close this message to return to the current workspace."
              : "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings.")
            : "Preparing assets, shaders, and the first frame."}
        />
        {failed ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onDismiss}>Close</Button>
            <Button size="sm" onClick={onRetry}>Retry</Button>
          </DialogFooter>
        ) : (
          <Progress value={progress} className="items-center gap-2" data-testid="scene-loading-progress">
            <LoaderCircleIcon aria-hidden className="size-4 text-primary motion-safe:animate-spin" />
            <ProgressLabel className="font-normal text-foreground">{phase}</ProgressLabel>
            <ProgressValue className="text-xs" />
          </Progress>
        )}
        {!failed && onStop ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onStop}>Stop</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
