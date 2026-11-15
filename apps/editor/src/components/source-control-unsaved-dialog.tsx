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
import { Button } from "@haptic/ui/components/button";

/**
 * The unsaved-documents step before an operation that rewrites files (Pull,
 * Revert Asset): the documents listed, **Cancel**, **Discard** (reload them
 * from disk) and **Save All**. `testId` prefixes the step's test ids.
 */
export function UnsavedDocumentsDialog({
  open,
  names,
  description,
  busy,
  testId,
  onCancel,
  onDiscard,
  onSave,
}: {
  open: boolean;
  names: readonly string[];
  description: string;
  busy: boolean;
  testId: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <AlertDialogContent data-testid={`${testId}-unsaved`}>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Documents</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border bg-muted/30 text-sm">
          {names.map((name) => (
            <li key={name} className="min-w-0 truncate px-3 py-1.5" title={name}>{name}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={`${testId}-unsaved-cancel`} disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="secondary" data-testid={`${testId}-discard`} disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <AlertDialogAction data-testid={`${testId}-save`} disabled={busy} onClick={onSave}>
            Save All
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
