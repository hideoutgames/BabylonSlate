import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import { Dialog } from "@haptic/ui/components/dialog";
import { Button } from "@haptic/ui/components/button";
import type { SceneViewportLoadPhase } from "../lib/scene-viewport-load";
import type { SceneLoadPhase } from "@haptic/render";
import {
  ProgressDialogContent,
  ProgressDialogFailure,
  ProgressDialogStatus,
} from "./progress-dialog-parts";
import { copyText } from "../lib/diagnostic-info";
import { useBlockingSceneLoad } from "../lib/blocking-scene-loads";

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
  /** Where focus returns on close, e.g. the game canvas that owns exclusive input. */
  finalFocus?: RefObject<HTMLElement | null>;
  /** Debug Mode only: builds the text **Copy Error** / **Copy Details** puts on the clipboard. */
  onCopyDetails?: () => string;
  /** A user-facing failure reason (such as an unsupported file format) shown instead of the generic text. */
  reason?: string;
};

/** Copies synchronously built text inside the tap and shows the result briefly. */
function CopyDetailsButton({ label, build, ...props }: { label: string; build: () => string } & Omit<ComponentProps<typeof Button>, "onClick" | "children">) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button {...props} data-testid="scene-loading-copy" onClick={() => { void copyText(build()).then((ok) => setState(ok ? "copied" : "failed")); }}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy Failed" : label}
    </Button>
  );
}

export function SceneLoadingDialog({
  open,
  progress,
  phase,
  failed = false,
  rendering = false,
  onRetry,
  onDismiss,
  onStop,
  finalFocus,
  onCopyDetails,
  reason,
}: SceneLoadingDialogProps) {
  // Every blocking load shows this dialog: while it shows a load's progress,
  // background captures on the shared Engine wait. A rendering update does not
  // hold them: each settings change starts one, and a dragged slider would
  // interrupt the same capture over and over.
  useBlockingSceneLoad(open && !failed && !rendering);
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <ProgressDialogContent
        failed={failed}
        overlayClassName="data-closed:pointer-events-none"
        data-testid="scene-loading-dialog"
        finalFocus={finalFocus}
      >
        {failed ? (
          <ProgressDialogFailure
            title={rendering ? "Rendering Update Failed" : "Scene Loading Failed"}
            description={reason
              ? `${reason} Close this message to return to the current workspace.`
              : phase === "Loading Document"
              ? "The scene document could not be read. Retry, or close this message to return to the current workspace."
              : "The viewport could not finish loading. Retry, or close this message to adjust the scene or rendering settings."}
            actions={(
              <>
                {onCopyDetails ? <CopyDetailsButton label="Copy Error" build={onCopyDetails} variant="outline" size="sm" /> : null}
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
            action={onStop || onCopyDetails ? (
              <>
                {onCopyDetails ? (
                  <CopyDetailsButton label="Copy Details" build={onCopyDetails} variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" />
                ) : null}
                {onStop ? (
                  <Button variant="ghost" size="xs" className="-mr-1 text-muted-foreground hover:text-foreground" onClick={onStop}>Stop</Button>
                ) : null}
              </>
            ) : null}
          />
        )}
      </ProgressDialogContent>
    </Dialog>
  );
}
