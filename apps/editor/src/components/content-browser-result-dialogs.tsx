import type { ReactNode } from "react";
import { SelectableText } from "@haptic/editor-kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { DocumentOpenErrorDialog } from "./document-open-error-dialog";

interface ContentBrowserResultDialogsProps {
  retargetErrors: string[] | null;
  setRetargetErrors: (errors: string[] | null) => void;
  importErrors: string[] | null;
  setImportErrors: (errors: string[] | null) => void;
  importedFileCount: number;
  openError: string | null;
  setOpenError: (error: string | null) => void;
}

/** Retarget and import failures, and an asset that could not open. */
export function ContentBrowserResultDialogs({
  retargetErrors,
  setRetargetErrors,
  importErrors,
  setImportErrors,
  importedFileCount,
  openError,
  setOpenError,
}: ContentBrowserResultDialogsProps) {
  return (
    <>
      <ErrorListDialog
        errors={retargetErrors}
        onClose={() => setRetargetErrors(null)}
        testId="content-browser-retarget-errors"
        dismissTestId="content-browser-retarget-errors-dismiss"
        title="Retarget Failed"
        description="Retargeting could not complete for the items below."
      />

      <ErrorListDialog
        errors={importErrors}
        onClose={() => setImportErrors(null)}
        testId="import-errors-dialog"
        dismissTestId="import-errors-dismiss"
        title={importedFileCount > 0 ? "Import Partially Completed" : "Import Failed"}
        descriptionTestId="import-result-summary"
        description={<>
          {importedFileCount > 0 ? `${importedFileCount} file${importedFileCount === 1 ? "" : "s"} imported successfully. ` : ""}
          {importErrors?.length} issue{importErrors?.length === 1 ? "" : "s"} need attention. Successfully imported assets remain in the project.
        </>}
      />
      <DocumentOpenErrorDialog
        error={openError}
        onClose={() => setOpenError(null)}
        testId="content-browser-open-error"
        dismissTestId="content-browser-open-error-dismiss"
      />
    </>
  );
}

/** A blocking list of failure messages with one Close action. */
function ErrorListDialog({
  errors,
  onClose,
  testId,
  dismissTestId,
  title,
  description,
  descriptionTestId,
}: {
  errors: readonly string[] | null;
  onClose: () => void;
  testId: string;
  dismissTestId: string;
  title: string;
  description: ReactNode;
  descriptionTestId?: string;
}) {
  return (
    <AlertDialog
      open={errors !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription data-testid={descriptionTestId}>
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {/* Two files can fail with the same message. */}
          {errors?.map((message, index) => (
            <li key={`${index}:${message}`}>
              <SelectableText>{message}</SelectableText>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogAction data-testid={dismissTestId} onClick={onClose}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
