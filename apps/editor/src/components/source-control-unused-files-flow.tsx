import { useEffect, useRef, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { isSyncError } from "@haptic/source-control";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Progress } from "@haptic/ui/components/progress";
import { useDocumentActions, useIntegratedSync, useSaveState } from "../context/document-context";
import { bytesLabel } from "../lib/source-control-labels";
import type { UnusedFiles } from "../services/source-control-sync";

type Step =
  | { kind: "blocked"; reason: string }
  | { kind: "finding" }
  | { kind: "confirm"; found: UnusedFiles }
  /** `started` once files go: until then it waits for other writers, and Cancel removes nothing. */
  | { kind: "removing"; started: boolean; cancelling: boolean }
  | { kind: "done"; removed: UnusedFiles }
  | { kind: "failed"; title: string; message: string };

/** `1 Unused File`, `4 Unused Files`. */
function filesLabel(count: number): string {
  return `${count} Unused ${count === 1 ? "File" : "Files"}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * **Remove Unused Files…** from the Changes window's menu: refused while
 * documents are read-only (Play, Simulation, a pull) or unsaved; finds the
 * blob files nothing needs (`SourceControlSyncService.findUnusedFiles`),
 * confirms with their count and size, then removes them in the project
 * write queue (`removeUnusedFiles`, which checks each again as the project's
 * only writer) and says what it removed. While it waits for other writers
 * (a Texture encode may take minutes), **Cancel** ends it with nothing
 * removed; once files go it runs to the end.
 */

function doneTitle(removed: UnusedFiles): string {
  if (removed.paths.length > 0) return `Removed ${filesLabel(removed.paths.length)}`;
  return removed.linkedBlobFolders ? "Nothing Removed" : "No Unused Files";
}

function doneMessage(removed: UnusedFiles): string {
  if (removed.paths.length > 0) return `${bytesLabel(removed.bytes)} freed.`;
  if (removed.linkedBlobFolders) {
    return "A stored asset data folder is a symbolic link or holds one, so the same file can appear under two paths and Haptic cannot tell which files are unused.";
  }
  return "All stored asset data is used by an asset or by a commit that is not pushed yet.";
}

export function SourceControlUnusedFilesFlow({ onDone }: { onDone: () => void }) {
  const sync = useIntegratedSync();
  const { dirtyDocuments, projectDirty } = useSaveState();
  const { getAuthoringLock, withProjectWrites } = useDocumentActions();
  const refusal = (): string | null => {
    const lock = getAuthoringLock();
    if (lock.readOnly) return lock.reason ?? "Documents are read-only right now.";
    const names = [...dirtyDocuments.map((doc) => doc.ref.label), ...(projectDirty ? ["Project Settings"] : [])];
    return names.length > 0 ? `Save or discard your changes to ${names.join(", ")} first.` : null;
  };
  const [step, setStep] = useState<Step>(() => {
    const reason = refusal();
    return reason ? { kind: "blocked", reason } : { kind: "finding" };
  });
  const finding = step.kind === "finding";
  /** The removal's cancel, while it runs. */
  const cancelRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!finding) return;
    let alive = true;
    sync.findUnusedFiles().then(
      (found) => {
        if (alive) setStep(found.paths.length > 0 ? { kind: "confirm", found } : { kind: "done", removed: found });
      },
      (error: unknown) => {
        if (alive) setStep({ kind: "failed", title: "Could Not Find Unused Files", message: messageOf(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [finding, sync]);

  const remove = async (found: UnusedFiles) => {
    // An edit or a lock that arrived since the confirmation opened refuses it.
    const reason = refusal();
    if (reason) {
      setStep({ kind: "blocked", reason });
      return;
    }
    const cancel = new AbortController();
    cancelRef.current = cancel;
    setStep({ kind: "removing", started: false, cancelling: false });
    try {
      const removed = await withProjectWrites(() => sync.removeUnusedFiles(found.paths, {
        signal: cancel.signal,
        onRemoving: () => setStep((current) => (current.kind === "removing" ? { kind: "removing", started: true, cancelling: false } : current)),
      }));
      setStep({ kind: "done", removed });
    } catch (error) {
      // Cancelled before any file went: nothing was removed, and nothing to say.
      if (cancel.signal.aborted && isSyncError(error) && error.kind === "cancelled") onDone();
      else setStep({ kind: "failed", title: "Could Not Remove Unused Files", message: messageOf(error) });
    } finally {
      cancelRef.current = null;
    }
  };

  // Only while it waits: once files go, it runs to the end (a Cancel that lands then changes nothing).
  // The step closes once the wait has ended.
  const cancelRemoving = () => {
    if (step.kind !== "removing" || step.started) return;
    cancelRef.current?.abort();
    setStep({ ...step, cancelling: true });
  };

  const closable = (open: boolean) => {
    if (!open) onDone();
  };

  return (
    <>
      <AlertDialog open={step.kind === "blocked" || step.kind === "failed"} onOpenChange={closable}>
        <AlertDialogContent data-testid={step.kind === "failed" ? "source-control-unused-failed" : "source-control-unused-blocked"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{step.kind === "failed" ? step.title : "Cannot Remove Unused Files Now"}</AlertDialogTitle>
            <AlertDialogDescription>{step.kind === "blocked" ? step.reason : step.kind === "failed" ? step.message : null}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reading is safe to leave: Cancel only stops waiting for the answer. */}
      <AlertDialog open={finding} onOpenChange={closable}>
        <AlertDialogContent data-testid="source-control-unused-finding">
          <AlertDialogHeader>
            <AlertDialogTitle>Finding Unused Files</AlertDialogTitle>
            <AlertDialogDescription>Checking which stored asset data the assets and unpushed commits still use.</AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label="Finding Unused Files" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step.kind === "confirm"} onOpenChange={closable}>
        <AlertDialogContent variant="warning" data-testid="source-control-unused-confirm">
          {step.kind === "confirm" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <TriangleAlertIcon aria-hidden="true" />
                </AlertDialogMedia>
                <AlertDialogTitle>Remove {filesLabel(step.found.paths.length)}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {bytesLabel(step.found.bytes)} of stored asset data that no asset uses and no unpushed commit holds. Removing it cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="source-control-unused-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction data-testid="source-control-unused-confirm-action" onClick={() => void remove(step.found)}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel while it waits for other writers; once files go, nothing closes it until they are removed. */}
      <AlertDialog open={step.kind === "removing"} onOpenChange={(open) => { if (!open) cancelRemoving(); }}>
        <AlertDialogContent data-testid="source-control-unused-removing">
          <AlertDialogHeader>
            <AlertDialogTitle>Removing Unused Files</AlertDialogTitle>
            <AlertDialogDescription>
              {step.kind === "removing" && !step.started
                ? "Waiting for saves, imports and Texture encodes to finish. Nothing is removed yet."
                : "Saves wait until the files are removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label="Removing Unused Files" />
          {step.kind === "removing" && !step.started ? (
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="source-control-unused-removing-cancel" disabled={step.cancelling}>
                Cancel
              </AlertDialogCancel>
            </AlertDialogFooter>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step.kind === "done"} onOpenChange={closable}>
        <AlertDialogContent data-testid="source-control-unused-done">
          {step.kind === "done" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>{doneTitle(step.removed)}</AlertDialogTitle>
              <AlertDialogDescription>{doneMessage(step.removed)}</AlertDialogDescription>
            </AlertDialogHeader>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
