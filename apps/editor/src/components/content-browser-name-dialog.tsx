import type { Dispatch, SetStateAction } from "react";
import { Input } from "@haptic/ui/components/input";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
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

export type NameEntry =
  | { kind: "rename"; guid: string; value: string }
  | { kind: "folder"; value: string }
  | { kind: "rename-folder"; path: string; value: string };

interface ContentBrowserNameDialogProps {
  nameDialog: NameEntry | null;
  setNameDialog: Dispatch<SetStateAction<NameEntry | null>>;
  nameDialogError: string | null;
  selectedFolderPath: string;
  operationError: string | null;
  busy: boolean;
  confirmNameDialog: () => void;
}

/** New Folder, Rename Folder and Rename Asset. */
export function ContentBrowserNameDialog({
  nameDialog,
  setNameDialog,
  nameDialogError,
  selectedFolderPath,
  operationError,
  busy,
  confirmNameDialog,
}: ContentBrowserNameDialogProps) {
  return (
    <AlertDialog
      open={nameDialog !== null}
      onOpenChange={(open) => {
        if (!open) setNameDialog(null);
      }}
    >
      <AlertDialogContent data-testid="content-browser-name-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {nameDialog?.kind === "folder"
              ? "New Folder"
              : nameDialog?.kind === "rename-folder"
                ? "Rename Folder"
                : "Rename Asset"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {nameDialog?.kind === "folder"
              ? `Create a folder in ${selectedFolderPath}.`
              : nameDialog?.kind === "rename-folder"
                ? "Rename the folder. References to its assets stay connected."
                : "Rename the asset file. References to it stay connected."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field data-invalid={Boolean(nameDialogError) || undefined}>
        <FieldLabel htmlFor="content-browser-name-input">Name</FieldLabel>
        <Input
          id="content-browser-name-input"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="content-browser-name-input"
            aria-describedby={
              nameDialogError ? "content-browser-name-error" : undefined
            }
          aria-invalid={Boolean(nameDialogError) || undefined}
          value={nameDialog?.value ?? ""}
          onChange={(event) =>
            setNameDialog((current) =>
              current ? { ...current, value: event.target.value } : current,
            )
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void confirmNameDialog();
          }}
        />
        </Field>
        {nameDialogError ? (
          <p
            className="text-sm text-destructive"
            data-testid="content-browser-name-taken"
              id="content-browser-name-error"
              role="alert"
          >
            {nameDialogError}
          </p>
        ) : null}
        {operationError ? (
          <Alert variant="destructive">
            <AlertTitle>Could Not Save Name</AlertTitle>
            <AlertDescription>{operationError}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || Boolean(nameDialogError)}
            data-testid="content-browser-name-confirm"
            onClick={(event) => {
              event.preventDefault();
              void confirmNameDialog();
            }}
          >
            {busy ? "Saving…" : nameDialog?.kind === "folder" ? "Create Folder" : "Rename"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
