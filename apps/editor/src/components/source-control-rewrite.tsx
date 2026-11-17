import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Progress } from "@haptic/ui/components/progress";
import { useDocumentActions, useIntegratedSync, useIntegratedSyncState, useSaveState } from "../context/document-context";
import type { AuthoringHold } from "../context/document-context-types";
import { transferLabel } from "../lib/source-control-labels";
import { useTransferBytes } from "../lib/transfer-bytes";
import type { UnsavedDocumentsDialog } from "./source-control-unsaved-dialog";

/** Where a flow that rewrites working files stands before it runs. */
export type RewriteStart =
  | { kind: "blocked"; reason: string }
  | { kind: "unsaved" }
  | { kind: "confirm" };

/**
 * The steps Pull, Switch Branch and Revert share before and while they
 * rewrite working files: refused while documents are read-only (Play, a
 * Simulation, another rewrite), then the unsaved documents it would reload
 * saved (**Save All**) or discarded (reloaded from disk), then its own
 * confirmation; from there `hold()` keeps documents read-only until its
 * files are reloaded (`applyPulledChanges`), released by `done()` or unmount.
 * `path` limits the documents to one asset's (Revert); otherwise every
 * unsaved document and Project Settings count.
 */
// The hook and the progress it drives belong together.
// eslint-disable-next-line react-refresh/only-export-components
export function useRewriteFlow<Step extends { kind: string }>({ path, reason, onDone }: {
  path?: string;
  /** Why documents are read-only; Play and Simulation name it when they refuse to start. */
  reason: string;
  onDone: () => void;
}) {
  const { dirtyDocuments, projectDirty } = useSaveState();
  const { saveAll, confirmExternalChangeReloadDocs, confirmExternalChangeReloadProject, getAuthoringLock, lockAuthoring } = useDocumentActions();
  const dirty = path === undefined ? dirtyDocuments : dirtyDocuments.filter((doc) => doc.ref.path === path);
  const project = path === undefined && projectDirty;
  const unsaved = dirty.length > 0 || project;
  const [step, setStep] = useState<Step | RewriteStart>(() => {
    // Open documents could not reload while Play or a Simulation holds them.
    const lock = getAuthoringLock();
    if (lock.readOnly) return { kind: "blocked", reason: lock.reason ?? "Documents are read-only right now." };
    return unsaved ? { kind: "unsaved" } : { kind: "confirm" };
  });
  const [busy, setBusy] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const held = useRef<AuthoringHold | null>(null);
  const release = useCallback(() => {
    held.current?.release();
    held.current = null;
  }, []);
  useEffect(() => release, [release]);
  const done = useCallback(() => {
    release();
    onDoneRef.current();
  }, [release]);

  // A save that lands while the prompt is open (Auto-Save) leaves nothing to ask about.
  useEffect(() => {
    if (step.kind === "unsaved" && !unsaved && !busy) setStep({ kind: "confirm" });
  }, [busy, step.kind, unsaved]);

  /** Documents read-only from now until `done()` (the reload releases the hold itself when it applies). */
  const hold = (): AuthoringHold => {
    if (!held.current) {
      const releaseLock = lockAuthoring(reason);
      held.current = { lock: getAuthoringLock(), release: releaseLock };
    }
    return held.current;
  };

  /** False, and the flow shows why, when a lock arrived since it opened (Play, a pull). */
  const allowed = (): boolean => {
    const lock = getAuthoringLock();
    if (!lock.readOnly || held.current) return true;
    setStep({ kind: "blocked", reason: lock.reason ?? "Documents are read-only right now." });
    return false;
  };

  const saveFirst = async () => {
    setBusy(true);
    try {
      // Documents someone else has locked stay unsaved and listed here, under Save Failed: its
      // Discard Changes moves the flow on, Ignore leaves Discard or Cancel here. Migrations
      // that refuse the save open their own prompt; the flow waits for another request.
      const outcome = await saveAll();
      if (outcome === "saved") setStep({ kind: "confirm" });
      else if (outcome !== "locked") done();
    } finally {
      setBusy(false);
    }
  };

  const discardFirst = async () => {
    setBusy(true);
    try {
      if (project) await confirmExternalChangeReloadProject();
      else await confirmExternalChangeReloadDocs(dirty.map((doc) => doc.ref.path));
      setStep({ kind: "confirm" });
    } finally {
      setBusy(false);
    }
  };

  /** The props of the flow's `UnsavedDocumentsDialog`, less its description and test ids. */
  const unsavedDialog = {
    open: step.kind === "unsaved",
    names: [...dirty.map((doc) => doc.ref.label), ...(project ? ["Project Settings"] : [])],
    busy,
    onCancel: done,
    onDiscard: () => void discardFirst(),
    onSave: () => void saveFirst(),
  } satisfies Partial<ComponentProps<typeof UnsavedDocumentsDialog>>;

  return { step, setStep, busy, setBusy, done, hold, release, allowed, unsavedDialog };
}

/** The running operation with its bytes, then what follows it (`after`); the only part of a flow that re-renders as bytes arrive. */
export function RewriteProgress({ after, label }: { after: string; label: string }) {
  const sync = useIntegratedSync();
  const transfer = transferLabel(useIntegratedSyncState(), useTransferBytes(sync.transfer));
  return (
    <div role="status" className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{transfer ?? after}</span>
      <Progress value={null} aria-label={label} />
    </div>
  );
}
