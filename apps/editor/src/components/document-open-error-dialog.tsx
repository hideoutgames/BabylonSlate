import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { useRetainedValue } from "../lib/use-retained-value";

/** **Could Not Open Asset** with the reason while `error` is set: an asset the Content Browser or a selected tab could not open. */
export function DocumentOpenErrorDialog({
  error,
  onClose,
  testId,
  dismissTestId,
}: {
  error: string | null;
  onClose: () => void;
  testId: string;
  dismissTestId: string;
}) {
  // Kept while the dialog fades out.
  const shown = useRetainedValue(error, "The asset could not be opened.");
  return (
    <AlertDialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>Could Not Open Asset</AlertDialogTitle>
          <AlertDialogDescription>{shown}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction data-testid={dismissTestId} onClick={onClose}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
