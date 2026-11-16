import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
import { useDocumentActions, useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { refCommit, refLabel } from "../services/source-control-diff";
import type { RevertRequest } from "./source-control-actions";
import { useRewriteFlow } from "./source-control-rewrite";
import { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

type Step =
  | { kind: "reverting" }
  | { kind: "failed"; message: string };

/** Why documents are read-only while a revert writes; Play and Simulation name it when they refuse to start. */
const REVERTING_REASON = "Read-only while reverting";

/**
 * Revert Asset and History's Revert To This Version: the asset's unsaved
 * edits are saved or discarded first, as before a pull; a warning
 * confirmation (it cannot be undone), which says Delete when the version does
 * not hold the asset (an added asset's HEAD); then, with documents read-only, the
 * version is written into the working copy with its blobs, in the project
 * write queue, and reloaded as a pull's files are.
 */
export default function SourceControlRevertFlow({ request, onDone }: { request: RevertRequest; onDone: () => void }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { withProjectWrites, applyPulledChanges } = useDocumentActions();
  const { step, setStep, done, hold, release, allowed, unsavedDialog } = useRewriteFlow<Step>({ path: request.path, reason: REVERTING_REASON, onDone });
  const version = refLabel(request.ref, snapshot);
  // Whether the version holds the asset (null until known): reverting to one that does not deletes it, which
  // the confirmation must say. A failed read leaves it to the revert, which reads the same version and fails too.
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    const commit = refCommit(request.ref, sync.getSnapshot());
    if (!commit) {
      setPresent(false);
      return;
    }
    let current = true;
    sync.readFileAt(request.path, commit).then(
      (bytes) => current && setPresent(bytes !== null),
      () => current && setPresent(true),
    );
    return () => {
      current = false;
    };
  }, [request.path, request.ref, sync]);

  const revert = async () => {
    // A lock that arrived since the flow opened (Play, a pull) refuses it.
    if (!allowed()) return;
    setStep({ kind: "reverting" });
    const held = hold();
    try {
      await withProjectWrites(async () => {
        const written = await sync.revert(request.path, refCommit(request.ref, sync.getSnapshot()));
        await applyPulledChanges(written, held);
      });
    } catch (error) {
      setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      release();
    }
    done();
  };

  return (
    <>
      <AlertDialog open={step.kind === "blocked" || step.kind === "failed"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent data-testid="source-control-revert-blocked">
          <AlertDialogHeader>
            <AlertDialogTitle>{step.kind === "failed" ? `Could Not Revert ${request.name}` : "Cannot Revert Now"}</AlertDialogTitle>
            <AlertDialogDescription>{step.kind === "blocked" ? step.reason : step.kind === "failed" ? step.message : null}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UnsavedDocumentsDialog
        {...unsavedDialog}
        description={`Save or discard your changes to ${request.name} before reverting it.`}
        testId="source-control-revert"
      />

      <AlertDialog open={step.kind === "confirm" && present !== null} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent variant="warning" data-testid="source-control-revert-confirm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{present ? `Revert ${request.name}?` : `Delete ${request.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {present
                ? `Reverting replaces ${request.name} with its version from ${version}. It cannot be undone.`
                : `${request.name} is not in ${version}, so reverting deletes it. It cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-control-revert-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="source-control-revert-confirm-action" onClick={() => void revert()}>
              {present ? "Revert" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No way to close it: it ends when the reverted files are loaded. */}
      <AlertDialog open={step.kind === "reverting"}>
        <AlertDialogContent data-testid="source-control-revert-running">
          <AlertDialogHeader>
            <AlertDialogTitle>{present ? `Reverting ${request.name}` : `Deleting ${request.name}`}</AlertDialogTitle>
            <AlertDialogDescription>Documents are read-only until the reverted files are loaded.</AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label={present ? "Reverting" : "Deleting"} />
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
