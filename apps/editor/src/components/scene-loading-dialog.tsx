import {
  ApertureIcon,
  BoxIcon,
  LoaderCircleIcon,
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
import {
  SCENE_LOAD_PHASES,
  type SceneViewportLoadPhase,
} from "../lib/scene-viewport-load";
import type { SceneLoadPhase } from "@babylonslate/render";
import { ProgressDialogHeader, ProgressStepList } from "./progress-dialog-parts";

type SceneLoadingPhase = SceneViewportLoadPhase | SceneLoadPhase;

/** Editor viewport open, reload, and rendering updates. Document reads show the phase alone. */
export const VIEWPORT_SCENE_LOAD_STEPS: readonly SceneLoadingPhase[] =
  SCENE_LOAD_PHASES.filter((phase) => phase !== "Loading Document");

/** Play scene transitions; steps a load skips (such as Removing Previous Scene) render complete. */
export const PLAY_SCENE_LOAD_STEPS: readonly SceneLoadPhase[] = [
  "Preparing Scene",
  "Removing Previous Scene",
  "Realizing Scene",
  "Loading Models",
  "Loading Textures",
  "Warming Shaders",
  "Presenting First Frame",
];

export type SceneLoadingDialogProps = {
  open: boolean;
  progress: number;
  phase: SceneLoadingPhase;
  steps?: readonly SceneLoadingPhase[];
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
  steps = VIEWPORT_SCENE_LOAD_STEPS,
  failed = false,
  rendering = false,
  onRetry,
  onDismiss,
  onStop,
}: SceneLoadingDialogProps) {
  const current = steps.indexOf(phase);
  const stepped = current >= 0;
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        data-testid="scene-loading-dialog"
      >
        <ProgressDialogHeader
          icon={failed ? TriangleAlertIcon : rendering ? ApertureIcon : BoxIcon}
          failed={failed}
          title={rendering
            ? (failed ? "Rendering Update Failed" : "Updating Rendering")
            : (failed ? "Scene Loading Failed" : "Loading Scene")}
          description={failed
            ? (phase === "Loading Document"
              ? "The scene document could not be read. Retry, or close this message to return to the current workspace."
              : "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings.")
            : "Preparing assets, shaders, and the first frame."}
          aside={!failed && stepped ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
              {Math.round(progress)}%
            </span>
          ) : null}
        />
        {failed ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onDismiss}>Close</Button>
            <Button size="sm" onClick={onRetry}>Retry</Button>
          </DialogFooter>
        ) : stepped ? (
          <Progress value={progress} data-testid="scene-loading-progress">
            <ProgressLabel className="sr-only">{phase}</ProgressLabel>
            <ProgressStepList
              steps={steps.map((step) => ({ key: step, label: step }))}
              current={current}
              className="pl-2.5"
            />
          </Progress>
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
