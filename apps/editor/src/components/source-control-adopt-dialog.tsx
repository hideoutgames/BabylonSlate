import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
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

/**
 * The one-Git-app warning shown before Haptic runs Git in a desktop working
 * copy: when Mode switches to Integrated, and from the **Haptic Does Not Run
 * Git In This Folder Yet** blocker. **Use Haptic's Git Here** runs `onAccept`
 * (it records the answer on this device) and closes once it succeeds; a
 * failure stays in the dialog. **Cancel** stores nothing.
 */
export function AdoptGitFolderDialog({
  open,
  onOpenChange,
  onAccept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (next: boolean) => {
    if (busy) return;
    setError(null);
    onOpenChange(next);
  };
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAccept();
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent variant="warning" data-testid="source-control-adopt-confirm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <TriangleAlertIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Use Haptic As This Folder&apos;s Git App?</AlertDialogTitle>
          <AlertDialogDescription>
            Haptic will commit, pull and push in this folder. No other Git app may use it at the same time: two
            apps writing one repository can corrupt it. This device remembers your answer for this folder.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive" data-testid="source-control-adopt-error">
            <AlertTitle>Could Not Use Haptic&apos;s Git Here</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} data-testid="source-control-adopt-confirm-action" onClick={() => void accept()}>
            Use Haptic&apos;s Git Here
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
