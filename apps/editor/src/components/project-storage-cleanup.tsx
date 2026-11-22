import { useState } from "react";
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
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { useDocumentActions } from "../context/document-context";
import type { BlobReclaimResult } from "../services/project-service";

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a run did, as the row's status. */
export function projectStorageCleanupStatus(result: BlobReclaimResult): string {
  switch (result.status) {
    case "reclaimed":
      if (result.stopped) {
        return result.files > 0
          ? `Removed ${result.files} ${result.files === 1 ? "file" : "files"} (${megabytes(result.bytes)}). The project changed meanwhile, so some may remain: try again.`
          : "The project changed meanwhile, so nothing was removed. Try again.";
      }
      return result.files > 0 ? `Removed ${result.files} ${result.files === 1 ? "file" : "files"} (${megabytes(result.bytes)}).` : "Nothing to remove.";
    case "source-control":
      return "Source control manages this project's storage. Use Remove Unused Files in the Source Control tab.";
    case "incomplete":
      return `Nothing was removed: ${result.unreadable.length === 1 ? "an asset" : `${result.unreadable.length} assets`} could not be read (${result.unreadable.slice(0, 3).join(", ")}${result.unreadable.length > 3 ? ", …" : ""}).`;
    case "linked":
      return "Nothing was removed: a linked folder may share stored data with another folder.";
    case "no-project":
      return "No project is open.";
  }
}

/**
 * Project Settings > General > Storage: **Clean Unused Project Storage**
 * removes stored asset data no asset uses, after a confirmation, and says
 * what it removed. Haptic also does this on its own when a project opens on
 * iPad, Android and the web; on desktop only this button does.
 */
export function ProjectStorageCleanup({ sourceControlOn }: { sourceControlOn: boolean }) {
  const { reclaimUnusedProjectStorage } = useDocumentActions();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    setConfirming(false);
    setRunning(true);
    try {
      setStatus(projectStorageCleanupStatus(await reclaimUnusedProjectStorage()));
    } catch (error) {
      setStatus(`Could not clean unused storage: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <Field orientation="horizontal" className="settings-field">
        <FieldLabel htmlFor="clean-unused-project-storage">Unused Storage</FieldLabel>
        <Button
          variant="outline"
          size="sm"
          className="min-h-[var(--chrome-row,28px)] w-fit justify-self-end"
          id="clean-unused-project-storage"
          data-testid="clean-unused-project-storage"
          disabled={sourceControlOn || running}
          onClick={() => setConfirming(true)}
        >
          Clean Unused Project Storage
        </Button>
      </Field>
      {sourceControlOn ? (
        <p className="text-xs text-muted-foreground" data-testid="clean-unused-project-storage-status">
          Source control manages this project's storage. Use Remove Unused Files in the Source Control tab.
        </p>
      ) : status ? (
        <p role="status" className="text-xs text-muted-foreground" data-testid="clean-unused-project-storage-status">{status}</p>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="clean-unused-project-storage-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Unused Project Storage?</AlertDialogTitle>
            <AlertDialogDescription>
              Haptic removes stored asset data that no asset in this project uses. Close this project in other windows and apps first: Haptic can't see what they haven't saved. Saving is unavailable until it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="clean-unused-project-storage-run" onClick={() => void run()}>
              Clean Storage
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
