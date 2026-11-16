import type { FileLock } from "@haptic/source-control";
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

/**
 * **Force Unlock Asset?**: removing someone else's lock, which lets others edit
 * while its holder may still have unpushed changes. `lock` opens it; confirm
 * hands the lock back to the caller, which releases it.
 */
export function ForceUnlockDialog({
  lock,
  onCancel,
  onConfirm,
}: {
  lock: FileLock | null;
  onCancel: () => void;
  onConfirm: (lock: FileLock) => void;
}) {
  return (
    <AlertDialog open={lock !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent data-testid="locks-force-unlock-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Force Unlock Asset?</AlertDialogTitle>
          <AlertDialogDescription>
            {lock?.path} is locked by {lock?.ownerName}. Removing their lock allows others to edit while they may still have unsaved or unpushed changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="locks-force-unlock-confirm-action"
            onClick={() => {
              if (lock) onConfirm(lock);
            }}
          >
            Force Unlock
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
