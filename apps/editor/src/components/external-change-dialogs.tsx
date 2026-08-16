import type { ExternalChangeClassification } from "@babylonslate/assets";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";

export function ExternalChangeDialogs({
  prompt,
  onReloadProject,
  onReloadDocs,
  onKeepEdits,
  onDismiss,
}: {
  prompt: ExternalChangeClassification | null;
  onReloadProject: () => void;
  onReloadDocs: (paths: string[]) => void;
  onKeepEdits: () => void;
  onDismiss: () => void;
}) {
  if (!prompt || prompt.kind === "none") return null;

  if (prompt.kind === "reload-project") {
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
        <AlertDialogContent data-testid="external-change-reload-project">
          <AlertDialogHeader>
            <AlertDialogTitle>Reload Project</AlertDialogTitle>
            <AlertDialogDescription>
              Many files changed on disk, or project.json changed. Reload the
              project from disk?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="min-h-[var(--touch-target,44px)]"
              data-testid="external-change-reload-project-cancel"
            >
              Keep Open
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[var(--touch-target,44px)]"
              data-testid="external-change-reload-project-confirm"
              onClick={onReloadProject}
            >
              Reload Project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (prompt.kind === "dirty-disk") {
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
        <AlertDialogContent data-testid="external-change-dirty-disk">
          <AlertDialogHeader>
            <AlertDialogTitle>File Changed On Disk</AlertDialogTitle>
            <AlertDialogDescription>
              Unsaved edits will be lost if you reload from disk:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc pl-5 text-sm">
            {prompt.dirtyChangedPaths.map((path) => (
              <li key={path}>
                <SelectableText>{path}</SelectableText>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="min-h-[var(--touch-target,44px)]"
              data-testid="external-change-keep-edits"
              onClick={onKeepEdits}
            >
              Keep Edits
            </Button>
            <AlertDialogAction
              className="min-h-[var(--touch-target,44px)]"
              data-testid="external-change-reload-from-disk"
              onClick={() => onReloadDocs(prompt.dirtyChangedPaths)}
            >
              Reload From Disk
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent data-testid="external-change-reload-clean">
        <AlertDialogHeader>
          <AlertDialogTitle>Reload From Disk</AlertDialogTitle>
          <AlertDialogDescription>
            These open files changed on disk:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc pl-5 text-sm">
          {prompt.cleanChangedPaths.map((path) => (
            <li key={path}>
              <SelectableText>{path}</SelectableText>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="min-h-[var(--touch-target,44px)]"
            data-testid="external-change-reload-clean-cancel"
          >
            Keep Open
          </AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[var(--touch-target,44px)]"
            data-testid="external-change-reload-clean-confirm"
            onClick={() => onReloadDocs(prompt.cleanChangedPaths)}
          >
            Reload From Disk
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
