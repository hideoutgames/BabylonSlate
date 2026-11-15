import { useEffect, useRef, useState } from "react";
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
import { useDocumentActions, useIntegratedSync, useIntegratedSyncState, useSaveState } from "../context/document-context";
import { refCommit, refLabel } from "../services/source-control-diff";
import type { RevertRequest } from "./source-control-actions";
import { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

type Step =
  | { kind: "blocked"; reason: string }
  | { kind: "unsaved" }
  | { kind: "confirm" }
  | { kind: "reverting" }
  | { kind: "failed"; message: string };

/** Why documents are read-only while a revert writes; Play and Simulation name it when they refuse to start. */
const REVERTING_REASON = "Read-only while reverting";

/**
 * Revert Asset (and, later, History's Revert To This Version): the asset's
 * unsaved edits are saved or discarded first, as before a pull; a warning
 * confirmation (it cannot be undone); then, with documents read-only, the
 * version is written into the working copy with its blobs, in the project
 * write queue, and reloaded as a pull's files are.
 */
export default function SourceControlRevertFlow({ request, onDone }: { request: RevertRequest; onDone: () => void }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { dirtyDocuments } = useSaveState();
  const { saveAll, confirmExternalChangeReloadDocs, withProjectWrites, applyPulledChanges, getAuthoringLock, lockAuthoring } = useDocumentActions();
  const dirty = dirtyDocuments.filter((doc) => doc.ref.path === request.path);
  const [step, setStep] = useState<Step>(() => {
    const lock = getAuthoringLock();
    if (lock.readOnly) return { kind: "blocked", reason: lock.reason ?? "Documents are read-only right now." };
    return dirty.length > 0 ? { kind: "unsaved" } : { kind: "confirm" };
  });
  const [busy, setBusy] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const done = () => onDoneRef.current();
  const version = refLabel(request.ref, snapshot);

  // A save that lands while the prompt is open (Auto-Save) leaves nothing to ask about.
  useEffect(() => {
    if (step.kind === "unsaved" && dirty.length === 0 && !busy) setStep({ kind: "confirm" });
  }, [busy, dirty.length, step.kind]);

  const revert = async () => {
    // A lock that arrived since the flow opened (Play, a pull) refuses it.
    const lock = getAuthoringLock();
    if (lock.readOnly) {
      setStep({ kind: "blocked", reason: lock.reason ?? "Documents are read-only right now." });
      return;
    }
    setStep({ kind: "reverting" });
    const release = lockAuthoring(REVERTING_REASON);
    const hold = { lock: getAuthoringLock(), release };
    try {
      await withProjectWrites(async () => {
        const written = await sync.revert(request.path, refCommit(request.ref, sync.getSnapshot()));
        await applyPulledChanges(written, hold);
      });
    } catch (error) {
      setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      hold.release();
    }
    done();
  };

  const saveFirst = async () => {
    setBusy(true);
    try {
      if (await saveAll()) setStep({ kind: "confirm" });
      else done();
    } finally {
      setBusy(false);
    }
  };

  const discardFirst = async () => {
    setBusy(true);
    try {
      await confirmExternalChangeReloadDocs([request.path]);
      setStep({ kind: "confirm" });
    } finally {
      setBusy(false);
    }
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
        open={step.kind === "unsaved"}
        names={dirty.map((doc) => doc.ref.label)}
        description={`Save or discard your changes to ${request.name} before reverting it.`}
        busy={busy}
        testId="source-control-revert"
        onCancel={done}
        onDiscard={() => void discardFirst()}
        onSave={() => void saveFirst()}
      />

      <AlertDialog open={step.kind === "confirm"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent variant="warning" data-testid="source-control-revert-confirm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Revert {request.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Reverting replaces {request.name} with its version from {version}. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-control-revert-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="source-control-revert-confirm-action" onClick={() => void revert()}>
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No way to close it: it ends when the reverted files are loaded. */}
      <AlertDialog open={step.kind === "reverting"}>
        <AlertDialogContent data-testid="source-control-revert-running">
          <AlertDialogHeader>
            <AlertDialogTitle>Reverting {request.name}</AlertDialogTitle>
            <AlertDialogDescription>Documents are read-only until the reverted files are loaded.</AlertDialogDescription>
          </AlertDialogHeader>
          <Progress value={null} aria-label="Reverting" />
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
