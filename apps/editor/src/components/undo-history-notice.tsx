import { useEffect } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";

/** Long enough to read; the notice never blocks editing meanwhile. */
const NOTICE_DURATION_MS = 8000;

/**
 * Floating, non-blocking notice over a document: its last edit applied but
 * was larger than the Undo memory limit, so it cleared the Undo history.
 */
export function UndoHistoryNotice({ documentId }: { documentId: string }) {
  const { undoHistoryNotice, dismissUndoHistoryNotice } = useDocuments();
  const sequence = undoHistoryNotice?.documentId === documentId
    ? undoHistoryNotice.sequence
    : null;
  useEffect(() => {
    if (sequence === null) return;
    const timer = setTimeout(dismissUndoHistoryNotice, NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [dismissUndoHistoryNotice, sequence]);
  if (sequence === null) return null;
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-end">
      <Alert role="status" className="pointer-events-auto max-w-sm shadow-md" data-testid="undo-history-notice">
        <AlertTitle>Can't Be Undone</AlertTitle>
        <AlertDescription>
          This edit can't be undone because it is larger than the Undo Memory Limit.
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:min-h-11"
            data-testid="undo-history-notice-dismiss"
            onClick={dismissUndoHistoryNotice}
          >
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
