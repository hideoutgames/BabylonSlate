import { useCallback, useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import type { ProjectEngineSession, ProjectEngineState } from "../lib/project-engine";

/** Long enough to read; the notice never blocks editing meanwhile. */
const NOTICE_DURATION_MS = 12_000;

/**
 * Floating, non-blocking notice that the project asked for WebGPU but its
 * renderer started on WebGL2 because WebGPU failed to initialize. Shown once
 * per Engine; the GPU Backend setting is unchanged.
 */
export function RenderingFallbackNotice({ state }: { state: ProjectEngineState }) {
  const session = state.phase === "ready" ? state.session : null;
  const reason = session ? state.webGpuFallbackReason : undefined;
  const [dismissed, setDismissed] = useState<ProjectEngineSession | null>(null);
  const visible = Boolean(reason) && dismissed !== session;
  const dismiss = useCallback(() => setDismissed(session), [session]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(dismiss, NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [dismiss, visible]);
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-40 flex justify-end">
      <Alert role="status" className="pointer-events-auto max-w-sm shadow-md" data-testid="rendering-fallback-notice">
        <AlertTitle>WebGPU Unavailable</AlertTitle>
        <AlertDescription>
          {reason} The GPU Backend setting still requests WebGPU.
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:min-h-11"
            data-testid="rendering-fallback-notice-dismiss"
            onClick={dismiss}
          >
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
