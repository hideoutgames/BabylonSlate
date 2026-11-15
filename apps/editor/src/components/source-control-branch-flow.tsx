import { useMemo } from "react";
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
import { useDocumentActions, useIntegratedSync, useRegistryState } from "../context/document-context";
import { groupChanges, registryChangeLookup } from "../lib/source-control-changes";
import { useSourceControlActions } from "./source-control-actions";
import { RewriteProgress, useRewriteFlow } from "./source-control-rewrite";
import { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

type Step =
  | { kind: "switching" }
  /** Uncommitted changes the switch would overwrite, by asset name. */
  | { kind: "refused"; names: readonly string[] }
  | { kind: "failed"; message: string };

/** Why documents are read-only while a switch rewrites files; Play and Simulation name it when they refuse to start. */
const SWITCHING_REASON = "Read-only while switching branch";

/**
 * Switch Branch, as the branch menus start it: unsaved documents are saved
 * or discarded first, the switch is confirmed (it cannot be undone), then,
 * with documents read-only behind the modal Switching step, the files that
 * differ are checked out in the project write queue and reloaded as a
 * pull's are. A file with uncommitted changes the switch would overwrite
 * refuses it, naming the assets, and nothing changes.
 */
export default function SourceControlBranchFlow({ branch, onDone }: { branch: string; onDone: () => void }) {
  const sync = useIntegratedSync();
  const { assetRegistry } = useRegistryState();
  const { withProjectWrites, applyPulledChanges } = useDocumentActions();
  const { openSourceControl } = useSourceControlActions();
  const { step, setStep, done, hold, release, allowed, unsavedDialog } = useRewriteFlow<Step>({ reason: SWITCHING_REASON, onDone });
  const lookup = useMemo(() => registryChangeLookup(assetRegistry), [assetRegistry]);

  const switchBranch = async () => {
    if (!allowed()) return;
    setStep({ kind: "switching" });
    const held = hold();
    let switched = false;
    try {
      await withProjectWrites(async () => {
        const { changedPaths } = await sync.switchBranch(branch);
        switched = true;
        // In the same write-queue turn: a save queued behind the switch finds the reloaded documents.
        await applyPulledChanges(changedPaths, held);
      });
    } catch (error) {
      if (!switched) {
        if (isSyncError(error) && error.code === "uncommitted-changes" && error.paths) {
          const names = groupChanges(error.paths.map((path) => ({ path, kind: "modified" as const })), lookup).rows.map((row) => row.name);
          setStep({ kind: "refused", names: names.length > 0 ? names : error.paths });
        } else {
          setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // The switch went through; a reload that failed leaves its changes to the next foreground rescan.
      console.warn("[editor] Could not reload the switched branch's files", error);
    } finally {
      release();
    }
    done();
  };

  return (
    <>
      <AlertDialog open={step.kind === "blocked" || step.kind === "failed"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent data-testid="source-control-switch-blocked">
          <AlertDialogHeader>
            <AlertDialogTitle>{step.kind === "failed" ? `Could Not Switch To ${branch}` : "Cannot Switch Branch Now"}</AlertDialogTitle>
            <AlertDialogDescription>{step.kind === "blocked" ? step.reason : step.kind === "failed" ? step.message : null}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UnsavedDocumentsDialog {...unsavedDialog} description={`Save or discard your changes before switching to ${branch}.`} testId="source-control-switch" />

      <AlertDialog open={step.kind === "confirm"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent variant="warning" data-testid="source-control-switch-confirm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Switch To {branch}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files that differ on {branch} are replaced with its versions; your other uncommitted changes stay. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-control-switch-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="source-control-switch-confirm-action" onClick={() => void switchBranch()}>
              Switch Branch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No way to close it: it ends when the other branch's files are loaded. */}
      <AlertDialog open={step.kind === "switching"}>
        <AlertDialogContent data-testid="source-control-switch-running">
          <AlertDialogHeader>
            <AlertDialogTitle>Switching To {branch}</AlertDialogTitle>
            <AlertDialogDescription>Documents are read-only until {branch}&apos;s files are loaded.</AlertDialogDescription>
          </AlertDialogHeader>
          <RewriteProgress after={`Loading ${branch}'s Files…`} label="Switching Branch" />
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step.kind === "refused"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent data-testid="source-control-switch-refused">
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot Switch To {branch}</AlertDialogTitle>
            <AlertDialogDescription>
              {branch} has other versions of these assets, and their uncommitted changes would be lost. Commit or revert them first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-md border bg-muted/30 text-sm">
            {step.kind === "refused" ? step.names.map((name) => <li key={name} className="min-w-0 truncate px-3 py-1.5" title={name}>{name}</li>) : null}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <AlertDialogAction data-testid="source-control-switch-open-changes" onClick={() => { done(); openSourceControl(); }}>
              Open Source Control
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
