import { useEffect, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
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
  | { kind: "removing" }
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
 * only writer) and says what it removed.
 */
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
    setStep({ kind: "removing" });
    try {
      const removed = await withProjectWrites(() => sync.removeUnusedFiles(found.paths));
      setStep({ kind: "done", removed });
    } catch (error) {
      setStep({ kind: "failed", title: "Could Not Remove Unused Files", message: messageOf(error) });
    }
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

      {/* No way to close it: it ends when the files are removed. */}
      <AlertDialog open={step.kind === "removing"}>
        <AlertDialogContent data-testid="source-control-unused-removing">
          <AlertDialogHeader>
            <AlertDialogTitle>Removing Unused Files</AlertDialogTitle>
            <AlertDialogDescription>Saves wait until the files are removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label="Removing Unused Files" />
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step.kind === "done"} onOpenChange={closable}>
        <AlertDialogContent data-testid="source-control-unused-done">
          {step.kind === "done" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>{step.removed.paths.length > 0 ? `Removed ${filesLabel(step.removed.paths.length)}` : "No Unused Files"}</AlertDialogTitle>
              <AlertDialogDescription>
                {step.removed.paths.length > 0
                  ? `${bytesLabel(step.removed.bytes)} freed.`
                  : "All stored asset data is used by an asset or by a commit that is not pushed yet."}
              </AlertDialogDescription>
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
