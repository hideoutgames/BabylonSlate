import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";

/** A selected tab whose asset could not be read, as the Content Browser reports one it cannot open. */
export function DocumentOpenErrorDialog({ error, onClose }: { error: string | null; onClose: () => void }) {
  return (
    <AlertDialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid="document-open-error">
        <AlertDialogHeader>
          <AlertDialogTitle>Could Not Open Asset</AlertDialogTitle>
          <AlertDialogDescription>{error ?? "The asset could not be opened."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction data-testid="document-open-error-dismiss" onClick={onClose}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
