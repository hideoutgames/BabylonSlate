import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Button } from "@haptic/ui/components/button";
import { useDocumentActions, useEditorShellState } from "../context/document-context";
import type { SaveFailed, SaveFailedPurpose } from "../context/document-context-types";
import { useRetainedValue } from "../lib/use-retained-value";

const NOT_SAVED = "Someone else has locked these files, so your changes to them weren't saved. Everything else was saved.";

const DESCRIPTIONS: Record<SaveFailedPurpose, string> = {
  save: NOT_SAVED,
  play: `${NOT_SAVED} Play didn't start: discard these changes, wait until the lock is released, or choose Play Without Saving.`,
  preview: `${NOT_SAVED} Preview Build plays saved files only, so it didn't start until you discard these changes or the lock is released.`,
};

const EMPTY: SaveFailed = { documents: [], purpose: "save" };

/**
 * **Save Failed**: a Save All the user asked for (Save All, the close
 * prompt's Save All, Play's save) left documents unsaved because someone else
 * has locked their files. One prompt names every such file and its lock's
 * holder. **Discard Changes** reloads them all from disk; **Ignore** (and
 * Escape) keeps the changes in the editor, still unsaved, and saving them
 * stays refused while the lock is theirs.
 */
export function SaveFailedDialog() {
  const { saveFailed } = useEditorShellState();
  const { dismissSaveFailed, discardDocumentChanges } = useDocumentActions();
  const shown = useRetainedValue(saveFailed, EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ignore = () => {
    setError(false);
    dismissSaveFailed();
  };
  const discard = async () => {
    setBusy(true);
    setError(false);
    try {
      if (await discardDocumentChanges(shown.documents.map((doc) => doc.path))) dismissSaveFailed();
      else setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open={saveFailed !== null} onOpenChange={(next) => { if (!next && !busy) ignore(); }}>
      <AlertDialogContent data-testid="save-failed-dialog" data-purpose={shown.purpose}>
        <AlertDialogHeader>
          <AlertDialogTitle>Save Failed</AlertDialogTitle>
          <AlertDialogDescription>{DESCRIPTIONS[shown.purpose]}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm" data-testid="save-failed-files">
          {shown.documents.map((doc) => (
            <li key={doc.id} className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-1.5" title={doc.path}>
              <span className="min-w-0 truncate">{doc.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">Locked by {doc.holder}</span>
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="save-failed-discard-error">
            The changes could not be discarded now. Try again once Play, a Simulation or a pull has finished.
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button variant="secondary" data-testid="save-failed-discard" disabled={busy} onClick={() => void discard()}>
            Discard Changes
          </Button>
          <AlertDialogAction data-testid="save-failed-ignore" disabled={busy} onClick={ignore}>
            Ignore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
