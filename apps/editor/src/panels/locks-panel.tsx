import type { IDockviewPanelProps } from "dockview-react";
import { memo, useCallback, useEffect, useState } from "react";
import { PanelFrame, SelectableText } from "@haptic/editor-kit";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import type { FileLock } from "@haptic/source-control";
import { useSourceControl } from "../context/document-context";
import {
  formatLockAge,
  type SourceControlService,
} from "../services/source-control-service";

/** One lock; props are primitives and stable callbacks, so a refresh re-renders only rows that changed. */
const LockRow = memo(function LockRow({
  lock,
  age,
  pushed,
  pending,
  onRelease,
  onForceUnlock,
}: {
  lock: FileLock;
  /** Formatted by the panel on each render, so it ages while the row's lock is unchanged. */
  age: string;
  /** Own locks only, once a pushed check has run. */
  pushed: boolean | null;
  pending: boolean;
  onRelease: (id: string) => void;
  onForceUnlock: (lock: FileLock) => void;
}) {
  return (
    <li
      className="flex min-h-[var(--chrome-row,28px)] items-center gap-2 px-2 py-0.5 text-sm"
      data-testid={`locks-row-${lock.path}`}
      data-lock-ours={lock.ours ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <SelectableText className="truncate">{lock.path}</SelectableText>
        <span className="truncate text-xs text-muted-foreground">
          {lock.ownerName} · {age}
        </span>
      </div>
      {pushed !== null ? (
        <Badge variant={pushed ? "success" : "warning"} data-testid={`locks-pushed-${lock.path}`}>
          {pushed ? "Pushed" : "Not Pushed"}
        </Badge>
      ) : null}
      {lock.ours ? (
        <Button
          variant="outline"
          size="touch"
          data-testid={`locks-release-${lock.path}`}
          disabled={pending}
          onClick={() => onRelease(lock.id)}
        >
          Release
        </Button>
      ) : (
        <Button
          variant="outline"
          size="touch"
          data-testid={`locks-force-unlock-${lock.path}`}
          disabled={pending}
          onClick={() => onForceUnlock(lock)}
        >
          Force Unlock
        </Button>
      )}
    </li>
  );
});

function emptyLabel(sourceControl: SourceControlService): string {
  if (!sourceControl.active) return "Source Control Is Off.";
  if (sourceControl.signIn) return "Sign In To Use File Locking.";
  if (!sourceControl.enabled) return "Set Up Source Control In Project Settings.";
  const status = sourceControl.refreshState.status;
  if (status === "ready") return "No Locks.";
  if (status === "refreshing") return "Checking Locks…";
  if (status === "error") return "Lock Status Unavailable.";
  return "Refresh To Check Locks.";
}

export function LocksPanelContents({
  sourceControl,
}: {
  sourceControl: SourceControlService;
}) {
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false);
  const [confirmForceUnlock, setConfirmForceUnlock] = useState<FileLock | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locks = sourceControl.locks;
  const heldCount = sourceControl.heldCount;
  const refresh = sourceControl.refreshState;
  const unsupported = sourceControl.lockingUnsupported;
  const canReleasePushed = sourceControl.canReleasePushed;
  const pushedCheck = sourceControl.pushedCheck;
  const actionError = error ?? sourceControl.operationError;
  const now = Date.now();
  const ownPaths = locks.filter((lock) => lock.ours).map((lock) => lock.path).sort().join("\n");
  // Only what the action releases: a document with unsaved edits keeps its lock.
  const pushedCount = canReleasePushed && pushedCheck.status === "ready"
    ? locks.filter((lock) => lock.ours && pushedCheck.pushed.has(lock.path) && !sourceControl.hasUnsavedEdits(lock.path)).length
    : 0;

  // One remote tree read whenever the set of our locks changes, not on every poll.
  useEffect(() => {
    if (canReleasePushed) void sourceControl.checkPushed();
  }, [canReleasePushed, ownPaths, sourceControl]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, []);
  const release = useCallback((id: string) => void run(() => sourceControl.release(id)), [run, sourceControl]);
  const forceUnlock = useCallback((lock: FileLock) => setConfirmForceUnlock(lock), []);

  if (unsupported) {
    return (
      <PanelFrame data-testid="locks-panel">
        <p className="p-2 text-sm text-muted-foreground" data-testid="locks-unsupported">
          This Host Does Not Support File Locking.
        </p>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="locks-panel">
      <div className="flex flex-wrap items-center gap-1 p-2">
        <Button
          variant="outline"
          size="touch"
          data-testid="locks-refresh"
          disabled={!sourceControl.enabled || refresh.status === "refreshing"}
          onClick={() => {
            sourceControl.requestRefresh();
            if (canReleasePushed) void sourceControl.checkPushed();
          }}
        >
          {refresh.status === "refreshing" ? "Refreshing…" : "Refresh"}
        </Button>
        {canReleasePushed ? (
          <Button
            variant="outline"
            size="touch"
            data-testid="locks-release-pushed"
            disabled={pending || pushedCheck.status === "checking" || pushedCount === 0}
            onClick={() => void run(() => sourceControl.releasePushedMine())}
          >
            Release Pushed Locks ({pushedCount})
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="touch"
          data-testid="locks-release-all"
          disabled={pending || heldCount === 0}
          onClick={() => setConfirmReleaseAll(true)}
        >
          Release All My Locks ({heldCount})
        </Button>
      </div>
      {refresh.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could Not Refresh Locks</AlertTitle>
          <AlertDescription>
            {refresh.error} {refresh.lastSuccessAt ? "Showing the last known locks. Refresh to try again." : "Lock status is unavailable. Check Source Control in Engine Settings, then refresh."}
          </AlertDescription>
        </Alert>
      ) : null}
      {pushedCheck.error ? (
        <Alert variant="destructive" data-testid="locks-pushed-error">
          <AlertTitle>Could Not Check Pushed Files</AlertTitle>
          <AlertDescription>{pushedCheck.error}</AlertDescription>
        </Alert>
      ) : null}
      {actionError ? <Alert variant="destructive"><AlertTitle>Lock Action Failed</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert> : null}
      {refresh.lastSuccessAt ? (
        <p className="px-2 text-xs text-muted-foreground" role="status">
          Last Checked: {new Date(refresh.lastSuccessAt).toLocaleTimeString()}
        </p>
      ) : null}
      <ScrollArea className="flex-1 py-1">
        {locks.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{emptyLabel(sourceControl)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {locks.map((lock) => (
              <LockRow
                key={lock.id}
                lock={lock}
                age={formatLockAge(lock.lockedAt, now)}
                pushed={lock.ours && canReleasePushed && pushedCheck.status === "ready" ? pushedCheck.pushed.has(lock.path) : null}
                pending={pending}
                onRelease={release}
                onForceUnlock={forceUnlock}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
      <AlertDialog open={confirmReleaseAll} onOpenChange={setConfirmReleaseAll}>
        <AlertDialogContent data-testid="locks-release-all-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Release All My Locks</AlertDialogTitle>
            <AlertDialogDescription>
              Unpushed work becomes editable by others.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="locks-release-all-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="locks-release-all-confirm-action"
              onClick={() => {
                void run(() => sourceControl.releaseAllMine());
                setConfirmReleaseAll(false);
              }}
            >
              Release All My Locks
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmForceUnlock !== null} onOpenChange={(open) => { if (!open) setConfirmForceUnlock(null); }}>
        <AlertDialogContent data-testid="locks-force-unlock-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Force Unlock Asset?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmForceUnlock?.path} is locked by {confirmForceUnlock?.ownerName}. Removing their lock allows others to edit while they may still have unsaved or unpushed changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" data-testid="locks-force-unlock-confirm-action" onClick={() => {
              if (!confirmForceUnlock) return;
              const id = confirmForceUnlock.id;
              setConfirmForceUnlock(null);
              void run(() => sourceControl.forceUnlock(id));
            }}>Force Unlock</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelFrame>
  );
}

export function LocksPanel(_props: IDockviewPanelProps) {
  void _props;
  const { sourceControl } = useSourceControl();
  return <LocksPanelContents sourceControl={sourceControl} />;
}
