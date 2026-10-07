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

export type PlayUnsavedChoice = "save" | "skip";

export type PlayUnsavedDialogProps = {
  open: boolean;
  dirtyNames: readonly string[];
  /**
   * Preview Build packs the saved project, so it offers no Play without
   * Saving: unsaved edits would silently be missing from the build.
   */
  previewBuild: boolean;
  onChoose: (choice: PlayUnsavedChoice) => void;
  onCancel: () => void;
};

/** Play never writes unsaved edits to disk without asking first. */
export function PlayUnsavedDialog({
  open,
  dirtyNames,
  previewBuild,
  onChoose,
  onCancel,
}: PlayUnsavedDialogProps) {
  const names = dirtyNames.join(", ");
  const verb = previewBuild ? "Preview" : "Play";
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent data-testid="play-unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            {previewBuild
              ? "Preview Build uses the saved project. Save your changes before building?"
              : "Save your changes before playing? Play Without Saving runs your current edits and leaves the files on disk unchanged."}
          </AlertDialogDescription>
          {names ? (
            <p className="truncate text-xs text-muted-foreground" title={names} data-testid="play-unsaved-names">
              {names}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="play-unsaved-cancel">Cancel</AlertDialogCancel>
          {previewBuild ? null : (
            <AlertDialogAction
              variant="outline"
              data-testid="play-unsaved-skip"
              onClick={() => onChoose("skip")}
            >
              Play Without Saving
            </AlertDialogAction>
          )}
          <AlertDialogAction data-testid="play-unsaved-save" onClick={() => onChoose("save")}>
            Save &amp; {verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
