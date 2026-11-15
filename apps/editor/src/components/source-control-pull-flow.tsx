import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
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
import { Progress } from "@haptic/ui/components/progress";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import {
  useDocumentActions,
  useIntegratedSync,
  useIntegratedSyncState,
  useRegistryState,
  useSaveState,
} from "../context/document-context";
import type { AuthoringHold } from "../context/document-context-types";
import { commitsLabel, transferLabel } from "../lib/source-control-labels";
import { conflictChoices, groupConflicts, registryChangeLookup, type ConflictRow } from "../lib/source-control-changes";
import { useTransferBytes } from "../lib/transfer-bytes";
import type { SyncSnapshot } from "../services/source-control-sync";

type Step =
  | { kind: "blocked"; reason: string }
  | { kind: "unsaved" }
  | { kind: "confirm" }
  | { kind: "pulling" }
  | { kind: "conflicts"; conflicts: PullConflict[] };

/** Why documents are read-only while a pull runs; Play and Simulation name it when they refuse to start. */
const PULLING_REASON = "Read-only while pulling";

function sideLabel(row: ConflictRow): string {
  if (row.theirs === "deleted") return "Deleted There, Changed Here";
  if (row.mine === "deleted") return "Changed There, Deleted Here";
  return "Changed Here And There";
}

/** The running pull with its bytes, then the reload of what it wrote. */
function PullProgress({ snapshot }: { snapshot: SyncSnapshot }) {
  const transfer = transferLabel(snapshot, useTransferBytes(useIntegratedSync().transfer));
  return (
    <div role="status" className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{transfer ?? "Loading The Pulled Files…"}</span>
      <Progress value={null} aria-label="Pulling" />
    </div>
  );
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
export default function SourceControlPullFlow({ onDone }: { onDone: () => void }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { dirtyDocuments, projectDirty } = useSaveState();
  const { assetRegistry } = useRegistryState();
  const {
    saveAll,
    confirmExternalChangeReloadDocs,
    confirmExternalChangeReloadProject,
    withProjectWrites,
    applyPulledChanges,
    getAuthoringLock,
    lockAuthoring,
  } = useDocumentActions();
  const unsaved = dirtyDocuments.length > 0 || projectDirty;
  const [step, setStep] = useState<Step>(() => {
    // Open documents could not reload while Play or a Simulation holds them.
    const lock = getAuthoringLock();
    if (lock.readOnly) return { kind: "blocked", reason: lock.reason ?? "Documents are read-only right now." };
    return unsaved ? { kind: "unsaved" } : { kind: "confirm" };
  });
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ReadonlyMap<string, PullChoice>>(new Map());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  /** The documents' read-only hold, from the confirmation until the pulled files are reloaded. */
  const hold = useRef<AuthoringHold | null>(null);
  const releaseHold = useCallback(() => {
    hold.current?.release();
    hold.current = null;
  }, []);
  useEffect(() => releaseHold, [releaseHold]);
  const done = useRef(() => {
    releaseHold();
    onDoneRef.current();
  });
  const branch = snapshot.branch;
  const lookup = useMemo(() => registryChangeLookup(assetRegistry), [assetRegistry]);
  const rows = useMemo(() => (step.kind === "conflicts" ? groupConflicts(step.conflicts, lookup) : []), [lookup, step]);

  // A save that lands while the prompt is open (Auto-Save) leaves nothing to ask about.
  useEffect(() => {
    if (step.kind === "unsaved" && !unsaved && !busy) setStep({ kind: "confirm" });
  }, [busy, step.kind, unsaved]);

  const pull = async (chosen?: ReadonlyMap<string, PullChoice>) => {
    setBusy(true);
    // Applying choices keeps Pull Conflicts open (disabled) until the pull settles.
    if (!chosen) setStep({ kind: "pulling" });
    if (!hold.current) {
      const release = lockAuthoring(PULLING_REASON);
      hold.current = { lock: getAuthoringLock(), release };
    }
    const held = hold.current;
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
    done.current();
  };

  const saveFirst = async () => {
    setBusy(true);
    try {
      // Migrations that refuse the save open their own prompt; the pull waits for another request.
      if (await saveAll()) setStep({ kind: "confirm" });
      else done.current();
    } finally {
      setBusy(false);
    }
  };

  const discardFirst = async () => {
    setBusy(true);
    try {
      if (projectDirty) await confirmExternalChangeReloadProject();
      else await confirmExternalChangeReloadDocs(dirtyDocuments.map((doc) => doc.ref.path));
      setStep({ kind: "confirm" });
    } finally {
      setBusy(false);
    }
  };

  const missing = rows.find((row) => !choices.has(row.id));

  return (
    <>
      <AlertDialog open={step.kind === "blocked"} onOpenChange={(open) => { if (!open) done.current(); }}>
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
      <AlertDialog open={step.kind === "unsaved"} onOpenChange={(open) => { if (!open && !busy) done.current(); }}>
        <AlertDialogContent data-testid="source-control-pull-unsaved">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Documents</AlertDialogTitle>
            <AlertDialogDescription>Save or discard your changes before pulling.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-md border bg-muted/30 text-sm">
            {[...dirtyDocuments.map((doc) => doc.ref.label), ...(projectDirty ? ["Project Settings"] : [])].map((name) => (
              <li key={name} className="min-w-0 truncate px-3 py-1.5" title={name}>{name}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-control-pull-unsaved-cancel" disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="secondary" data-testid="source-control-pull-discard" disabled={busy} onClick={() => void discardFirst()}>
              Discard
            </Button>
            <AlertDialogAction data-testid="source-control-pull-save" disabled={busy} onClick={() => void saveFirst()}>
              Save All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step.kind === "confirm"} onOpenChange={(open) => { if (!open) done.current(); }}>
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
          <PullProgress snapshot={snapshot} />
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={step.kind === "conflicts"} onOpenChange={(open) => { if (!open && !busy) done.current(); }}>
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
            <Button variant="outline" data-testid="source-control-pull-conflicts-cancel" disabled={busy} onClick={() => done.current()}>
              Cancel Pull
            </Button>
            <Button data-testid="source-control-pull-conflicts-apply" disabled={busy || missing !== undefined} onClick={() => void pull(choices)}>
              Apply And Finish Pull
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
