import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { PanelFrame, SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
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
  const locks = sourceControl.locks;
  const heldCount = sourceControl.heldCount;

  return (
    <PanelFrame data-testid="locks-panel">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="locks-refresh"
          onClick={() => sourceControl.requestRefresh()}
        >
          Refresh
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="locks-release-all"
          disabled={heldCount === 0}
          onClick={() => setConfirmReleaseAll(true)}
        >
          Release All My Locks ({heldCount})
        </Button>
      </div>
      <ScrollArea className="flex-1 p-2">
        {locks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No locks.</p>
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
                    onClick={() => void sourceControl.release(lock.id)}
                  >
                    Release
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[var(--touch-target,44px)] w-fit"
                    data-testid={`locks-force-unlock-${lock.path}`}
                    onClick={() => void sourceControl.forceUnlock(lock.id)}
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
                void sourceControl.releaseAllMine();
                setConfirmReleaseAll(false);
              }}
            >
              Release All My Locks
            </AlertDialogAction>
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
