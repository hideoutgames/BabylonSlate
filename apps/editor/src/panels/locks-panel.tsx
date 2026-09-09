import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { PanelFrame, SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { useDocuments } from "../context/document-context";
import {
  formatLockAge,
  type SourceControlService,
} from "../services/source-control-service";

export function LocksPanelContents({
  sourceControl,
}: {
  sourceControl: SourceControlService;
}) {
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false);
  const [confirmForceUnlock, setConfirmForceUnlock] = useState<SourceControlService["locks"][number] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locks = sourceControl.locks;
  const heldCount = sourceControl.heldCount;
  const refresh = sourceControl.refreshState;
  const actionError = error ?? sourceControl.operationError;

  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <PanelFrame data-testid="locks-panel">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="locks-refresh"
          disabled={!sourceControl.enabled || refresh.status === "refreshing"}
          onClick={() => sourceControl.requestRefresh()}
        >
          {refresh.status === "refreshing" ? "Refreshing…" : "Refresh"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
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
            {refresh.error} {refresh.lastSuccessAt ? "Showing the last known locks. Refresh to try again." : "Lock status is unavailable. Check Source Control in Project Settings, then refresh."}
          </AlertDescription>
        </Alert>
      ) : null}
      {actionError ? <Alert variant="destructive"><AlertTitle>Lock Action Failed</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert> : null}
      {refresh.lastSuccessAt ? (
        <p className="px-2 text-xs text-muted-foreground" role="status">
          Last Checked: {new Date(refresh.lastSuccessAt).toLocaleTimeString()}
        </p>
      ) : null}
      <ScrollArea className="flex-1 p-2">
        {locks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {!sourceControl.settingsEnabled ? "Source Control Is Off." : !sourceControl.enabled ? "Set Up Source Control In Project Settings." : refresh.status === "ready" ? "No Locks." : refresh.status === "refreshing" ? "Checking Locks…" : refresh.status === "error" ? "Lock Status Unavailable." : "Refresh To Check Locks."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {locks.map((lock) => (
              <li
                key={lock.id}
                className="flex flex-col gap-1 rounded-md border p-2"
                data-testid={`locks-row-${lock.path}`}
                data-lock-ours={lock.ours ? "true" : "false"}
              >
                <SelectableText className="text-sm font-medium">
                  {lock.path}
                </SelectableText>
                <p className="text-xs text-muted-foreground">
                  {lock.ownerName} · {formatLockAge(lock.lockedAt)}
                </p>
                {lock.ours ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[var(--touch-target,44px)] w-fit"
                    data-testid={`locks-release-${lock.path}`}
                    disabled={pending}
                    onClick={() => void run(() => sourceControl.release(lock.id))}
                  >
                    Release
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[var(--touch-target,44px)] w-fit"
                    data-testid={`locks-force-unlock-${lock.path}`}
                    disabled={pending}
                    onClick={() => setConfirmForceUnlock(lock)}
                  >
                    Force Unlock
                  </Button>
                )}
              </li>
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
            <AlertDialogCancel
              className="min-h-[var(--touch-target,44px)]"
              data-testid="locks-release-all-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[var(--touch-target,44px)]"
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
            <AlertDialogAction data-testid="locks-force-unlock-confirm-action" onClick={() => {
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
  const { sourceControl } = useDocuments();
  return <LocksPanelContents sourceControl={sourceControl} />;
}
