import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";

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
          <AlertDialogDescription>{error ?? "The asset could not be opened."}</AlertDialogDescription>
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
