import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { useSaveState } from "../context/document-context";

/** Long enough to read; the notice never blocks editing meanwhile. */
const NOTICE_DURATION_MS = 8000;

/**
 * Floating, non-blocking notice, on every layout (phones hide the status
 * bar that also shows it): crash-recovery journaling paused, so a crash now
 * loses the edits since. Shown once each time journaling pauses, until
 * **Dismiss** or a few seconds pass.
 */
export function JournalPausedNotice() {
  const { journalPaused } = useSaveState();
  const [shown, setShown] = useState(false);
  // Each pause raises it once; a resume clears it for the next pause.
  const [raisedFor, setRaisedFor] = useState(false);
  if (journalPaused !== raisedFor) {
    setRaisedFor(journalPaused);
    setShown(journalPaused);
  }
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-2 bottom-[calc(var(--safe-bottom,0px)+3rem)] z-40 flex justify-center">
      <Alert role="status" className="pointer-events-auto max-w-sm shadow-md" data-testid="journal-paused-notice">
        <AlertTitle>Crash Recovery Paused — Use Save All</AlertTitle>
        <AlertDescription>
          Storage is full, so edits are no longer recorded for crash recovery. Free some space and choose Save All.
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:min-h-11"
            data-testid="journal-paused-notice-dismiss"
            onClick={() => setShown(false)}
          >
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
