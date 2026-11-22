import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { PROJECT_FILE } from "@haptic/core";
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
import { revertSettingsRefusal } from "../lib/project-settings-revert";
import { refCommit, refLabel } from "../services/source-control-diff";
import type { RevertRequest } from "./source-control-actions";
import { useRewriteFlow } from "./source-control-rewrite";
import { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

type Step =
  | { kind: "reverting" }
  | { kind: "failed"; message: string };

/** Why documents are read-only while a revert writes; Play and Simulation name it when they refuse to start. */
const REVERTING_REASON = "Read-only while reverting";

/** What the version holds, once read: the asset (or not), or why Project Settings cannot be reverted to it. */
type Version = { present: boolean; refusal: string | null };

/**
 * Revert Asset, Revert Project Settings and History's Revert To This Version:
 * unsaved edits are saved or discarded first, as before a pull (the asset's
 * own; for Project Settings every document's, since the project reloads); a
 * warning confirmation (it cannot be undone), which says Delete when the
 * version does not hold the asset (an added asset's HEAD); then, with
 * documents read-only, the version is written into the working copy with its
 * blobs, in the project write queue, and reloaded as a pull's files are: the
 * whole project, for Project Settings. Project Settings are refused for a
 * version without them, or one the project could not reopen from
 * (`revertSettingsRefusal`).
 */
export default function SourceControlRevertFlow({ request, onDone }: { request: RevertRequest; onDone: () => void }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { withProjectWrites, applyPulledChanges } = useDocumentActions();
  const project = request.path === PROJECT_FILE;
  const { step, setStep, done, hold, release, allowed, unsavedDialog } = useRewriteFlow<Step>({
    ...(project ? {} : { path: request.path }),
    reason: REVERTING_REASON,
    onDone,
  });
  const version = refLabel(request.ref, snapshot);
  // Whether the version holds the asset (null until known): reverting to one that does not deletes it, which
  // the confirmation must say. A failed read leaves it to the revert, which reads the same version and fails too.
  const [held, setHeld] = useState<Version | null>(null);
  useEffect(() => {
    const commit = refCommit(request.ref, sync.getSnapshot());
    const label = refLabel(request.ref, sync.getSnapshot());
    const found = (bytes: Uint8Array | null): Version => ({
      present: bytes !== null,
      refusal: project ? revertSettingsRefusal(label, bytes, sync.repositoryUrl) : null,
    });
    if (!commit) {
      setHeld(found(null));
      return;
    }
    let current = true;
    sync.readFileAt(request.path, commit).then(
      (bytes) => current && setHeld(found(bytes)),
      () => current && setHeld({ present: true, refusal: null }),
    );
    return () => {
      current = false;
    };
  }, [project, request.path, request.ref, sync]);
  const present = held?.present ?? null;
  // A version Project Settings cannot be reverted to is refused before anything is saved or discarded.
  const refusal = step.kind === "confirm" || step.kind === "unsaved" ? held?.refusal ?? null : null;

  const revert = async () => {
    // A lock that arrived since the flow opened (Play, a pull) refuses it.
    if (!allowed()) return;
    setStep({ kind: "reverting" });
    const holding = hold();
    try {
      await withProjectWrites(async () => {
        const written = await sync.revert(request.path, refCommit(request.ref, sync.getSnapshot()));
        // A written project.json reloads the project (nothing is unsaved: the flow saved or discarded it all).
        await applyPulledChanges(written, holding);
      });
    } catch (error) {
      setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      release();
    }
    done();
  };

  const blocked = step.kind === "blocked" || step.kind === "failed" || refusal !== null;
  return (
    <>
      <AlertDialog open={blocked} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent data-testid="source-control-revert-blocked">
          <AlertDialogHeader>
            <AlertDialogTitle>{step.kind === "failed" ? `Could Not Revert ${request.name}` : "Cannot Revert Now"}</AlertDialogTitle>
            <AlertDialogDescription>{step.kind === "blocked" ? step.reason : step.kind === "failed" ? step.message : refusal}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UnsavedDocumentsDialog
        {...unsavedDialog}
        open={unsavedDialog.open && refusal === null}
        description={project
          ? "Save or discard your changes before reverting Project Settings: the project reloads afterwards."
          : `Save or discard your changes to ${request.name} before reverting it.`}
        testId="source-control-revert"
      />

      <AlertDialog open={step.kind === "confirm" && held !== null && refusal === null} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent variant="warning" data-testid="source-control-revert-confirm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{present ? `Revert ${request.name}?` : `Delete ${request.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {project
                ? `Reverting replaces ${request.name} with their version from ${version}, then the project reloads. It cannot be undone.`
                : present
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
            <AlertDialogDescription>
              {project ? "Documents are read-only until the project reloads." : "Documents are read-only until the reverted files are loaded."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label={present ? "Reverting" : "Deleting"} />
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
