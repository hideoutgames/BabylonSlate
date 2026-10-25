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
      <AlertDialog
        open={retargetErrors !== null}
        onOpenChange={(open) => {
          if (!open) setRetargetErrors(null);
        }}
      >
        <AlertDialogContent data-testid="content-browser-retarget-errors">
          <AlertDialogHeader>
            <AlertDialogTitle>Retarget Failed</AlertDialogTitle>
            <AlertDialogDescription>
              Retargeting could not complete for the items below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {retargetErrors?.map((message) => (
              <li key={message}>
                <SelectableText>{message}</SelectableText>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="content-browser-retarget-errors-dismiss"
              onClick={() => setRetargetErrors(null)}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={importErrors !== null}
        onOpenChange={(open) => {
          if (!open) setImportErrors(null);
        }}
      >
        <AlertDialogContent data-testid="import-errors-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{importedFileCount > 0 ? "Import Partially Completed" : "Import Failed"}</AlertDialogTitle>
            <AlertDialogDescription data-testid="import-result-summary">
              {importedFileCount > 0 ? `${importedFileCount} file${importedFileCount === 1 ? "" : "s"} imported successfully. ` : ""}
              {importErrors?.length} issue{importErrors?.length === 1 ? "" : "s"} need attention. Successfully imported assets remain in the project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {importErrors?.map((message) => (
              <li key={message}>
                <SelectableText>{message}</SelectableText>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="import-errors-dismiss"
              onClick={() => setImportErrors(null)}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={openError !== null}
        onOpenChange={(open) => {
          if (!open) setOpenError(null);
        }}
      >
        <AlertDialogContent data-testid="content-browser-open-error">
          <AlertDialogHeader>
            <AlertDialogTitle>Could Not Open Asset</AlertDialogTitle>
            <AlertDialogDescription>
              {openError ?? "The asset could not be opened."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="content-browser-open-error-dismiss"
              onClick={() => setOpenError(null)}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
