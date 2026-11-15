import { useMemo, useState } from "react";
import { CircleAlertIcon, GitCompareIcon, TriangleAlertIcon } from "lucide-react";
import type { PullChoice, PullConflict, PullResult } from "@haptic/source-control";
import { resolveTypeVisual, TypeVisualIcon } from "@haptic/editor-kit";
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
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import {
  useDocumentActions,
  useIntegratedSync,
  useIntegratedSyncState,
  useRegistryState,
} from "../context/document-context";
import { commitsLabel } from "../lib/source-control-labels";
import { conflictChoices, groupConflicts, registryChangeLookup, type ConflictRow } from "../lib/source-control-changes";
import { REMOTE, WORKING_COPY } from "../services/source-control-diff";
import type { DiffRequest } from "./source-control-actions";
import { RewriteProgress, useRewriteFlow } from "./source-control-rewrite";
import { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

type Step =
  | { kind: "pulling" }
  | { kind: "conflicts"; conflicts: PullConflict[] }
  /** Pull Conflicts set aside while the tab shows one asset's diff; the hold and the choices stay. */
  | { kind: "comparing"; conflicts: PullConflict[]; name: string };

/** While comparing, Pull Conflicts waits in the bottom right corner, above the status bar. */
const COMPARING_PLACEMENT = { top: "auto", left: "auto", right: "calc(var(--safe-right) + 0.5rem)", bottom: "calc(var(--safe-bottom) + 2.5rem)", translate: "none" } as const;

/** Why documents are read-only while a pull runs; Play and Simulation name it when they refuse to start. */
const PULLING_REASON = "Read-only while pulling";

function sideLabel(row: ConflictRow): string {
  if (row.theirs === "deleted") return "Deleted There, Changed Here";
  if (row.mine === "deleted") return "Changed There, Deleted Here";
  return "Changed Here And There";
}

/**
 * Pull, as the status bar, More Tools and the Changes window start it: unsaved
 * documents are saved or discarded first, the pull is confirmed (it cannot be
 * undone), then it fast-forwards or merges, or asks for a version of every
 * asset changed on both sides (Pull Conflicts). From the confirmation until
 * the pulled files are reloaded (as after an external change), documents are
 * read-only, so no edit, Play or Simulation meets a half-pulled project, and
 * the modal Pulling step covers the editor.
 */
export default function SourceControlPullFlow({ onDone, onCompare }: {
  onDone: () => void;
  /** Shows a conflicting asset's diff in the Source Control tab (each row's **Compare**). */
  onCompare?: (request: DiffRequest) => void;
}) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { assetRegistry } = useRegistryState();
  const { withProjectWrites, applyPulledChanges } = useDocumentActions();
  const { step, setStep, busy, setBusy, done, hold, allowed, unsavedDialog } = useRewriteFlow<Step>({ reason: PULLING_REASON, onDone });
  const [choices, setChoices] = useState<ReadonlyMap<string, PullChoice>>(new Map());
  const branch = snapshot.branch;
  const lookup = useMemo(() => registryChangeLookup(assetRegistry), [assetRegistry]);
  const conflicts = step.kind === "conflicts" || step.kind === "comparing" ? step.conflicts : null;
  const rows = useMemo(() => (conflicts ? groupConflicts(conflicts, lookup) : []), [conflicts, lookup]);
  // Base: the incoming version (the remote branch the pull fetched); compare: the working copy.
  const compare = (row: ConflictRow) => {
    if (!conflicts || !onCompare) return;
    onCompare({ path: row.id, name: row.name, type: row.type, base: REMOTE, compare: WORKING_COPY });
    setStep({ kind: "comparing", conflicts, name: row.name });
  };

  const pull = async (chosen?: ReadonlyMap<string, PullChoice>) => {
    if (!allowed()) return;
    setBusy(true);
    // Applying choices keeps Pull Conflicts open (disabled) until the pull settles.
    if (!chosen) setStep({ kind: "pulling" });
    const held = hold();
    let result: PullResult | null = null;
    try {
      result = await withProjectWrites(async () => {
        const pulled = await sync.pull(chosen ? conflictChoices(rows, chosen) : undefined);
        // In the same write-queue turn: a save queued behind the pull finds the reloaded documents.
        if (pulled && (pulled.kind === "fast-forward" || pulled.kind === "merged")) await applyPulledChanges(pulled.changedPaths, held);
        return pulled;
      });
    } catch (error) {
      // The pull itself reports through the sync snapshot; a reload that failed leaves its changes to the next foreground rescan.
      console.warn("[editor] Could not reload the pulled files", error);
    } finally {
      setBusy(false);
    }
    if (result?.kind === "conflicts") {
      setChoices(new Map());
      setStep({ kind: "conflicts", conflicts: result.conflicts });
      return;
    }
    done();
  };

  const missing = rows.find((row) => !choices.has(row.id));

  return (
    <>
      <AlertDialog open={step.kind === "blocked"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent data-testid="source-control-pull-blocked">
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot Pull Now</AlertDialogTitle>
            <AlertDialogDescription>{step.kind === "blocked" ? step.reason : null}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <UnsavedDocumentsDialog {...unsavedDialog} description="Save or discard your changes before pulling." testId="source-control-pull" />

      <AlertDialog open={step.kind === "confirm"} onOpenChange={(open) => { if (!open) done(); }}>
        <AlertDialogContent variant="warning" data-testid="source-control-pull-confirm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {snapshot.behind > 0 ? `Pull ${commitsLabel(snapshot.behind)} From ${branch}?` : `Pull From ${branch}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Pulling replaces files with their versions on {branch}. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-control-pull-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="source-control-pull-confirm-action" onClick={() => void pull()}>
              Pull
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No way to close it: it ends when the pulled files are loaded. */}
      <AlertDialog open={step.kind === "pulling"}>
        <AlertDialogContent data-testid="source-control-pull-running">
          <AlertDialogHeader>
            <AlertDialogTitle>Pulling From {branch}</AlertDialogTitle>
            <AlertDialogDescription>Documents are read-only until the pulled files are loaded.</AlertDialogDescription>
          </AlertDialogHeader>
          <RewriteProgress after="Loading The Pulled Files…" label="Pulling" />
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={step.kind === "conflicts"} onOpenChange={(open) => { if (!open && !busy) done(); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-lg" data-testid="source-control-pull-conflicts">
          <DialogHeader>
            <DialogTitle>Pull Conflicts</DialogTitle>
            <DialogDescription>
              {rows.length === 1 ? "1 asset" : `${rows.length} assets`} changed here and on {branch} since your last pull. Choose which version to keep for each.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
            {rows.map((row) => (
              <li key={row.id} className="flex min-h-[var(--chrome-row,28px)] items-center gap-2 px-2 py-1 text-sm" data-testid={`source-control-conflict-${row.id}`}>
                {row.type && row.type !== "Project" && row.type !== "Folder" ? <TypeVisualIcon visual={resolveTypeVisual({ assetType: row.type })} /> : null}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{row.folder} · {sideLabel(row)}</span>
                </div>
                {onCompare ? (
                  <Button variant="outline" size="sm" disabled={busy} data-testid={`source-control-conflict-compare-${row.id}`} onClick={() => compare(row)}>
                    <GitCompareIcon data-icon="inline-start" />
                    Compare
                  </Button>
                ) : null}
                <ToggleGroup
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-label={`Version For ${row.name}`}
                  value={choices.has(row.id) ? [choices.get(row.id)!] : []}
                  disabled={busy}
                  onValueChange={(value) => {
                    const next = value[0] as PullChoice | undefined;
                    setChoices((current) => {
                      const updated = new Map(current);
                      if (next) updated.set(row.id, next);
                      else updated.delete(row.id);
                      return updated;
                    });
                  }}
                >
                  <ToggleGroupItem value="mine" data-testid={`source-control-conflict-mine-${row.id}`}>Keep Mine</ToggleGroupItem>
                  <ToggleGroupItem value="theirs" data-testid={`source-control-conflict-theirs-${row.id}`}>Take Theirs</ToggleGroupItem>
                </ToggleGroup>
              </li>
            ))}
          </ul>
          <DialogFooter className="items-center">
            {missing ? (
              <span role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="source-control-pull-conflicts-reason">
                <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">Choose a version for {missing.name}.</span>
              </span>
            ) : null}
            <Button variant="outline" data-testid="source-control-pull-conflicts-cancel" disabled={busy} onClick={() => done()}>
              Cancel Pull
            </Button>
            <Button data-testid="source-control-pull-conflicts-apply" disabled={busy || missing !== undefined} onClick={() => void pull(choices)}>
              Apply And Finish Pull
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Non-modal, so the Source Control tab's diff can be read and scrolled beside it. */}
      <Dialog open={step.kind === "comparing"} modal={false} disablePointerDismissal onOpenChange={(open) => { if (!open && conflicts) setStep({ kind: "conflicts", conflicts }); }}>
        <DialogContent
          showOverlay={false}
          showCloseButton={false}
          className="sm:max-w-xs"
          style={COMPARING_PLACEMENT}
          data-testid="source-control-pull-comparing"
        >
          <DialogHeader>
            <DialogTitle>Pull Conflicts</DialogTitle>
            <DialogDescription>
              Comparing {step.kind === "comparing" ? step.name : ""} with {branch}. Documents stay read-only until the pull finishes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button data-testid="source-control-pull-comparing-back" onClick={() => { if (conflicts) setStep({ kind: "conflicts", conflicts }); }}>
              Back To Pull Conflicts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
