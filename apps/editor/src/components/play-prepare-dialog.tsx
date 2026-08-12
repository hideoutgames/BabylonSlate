import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";

export type PlayPreparePhase = "saving" | "compiling";

export type PlayPrepareDialogProps = {
  open: boolean;
  phase: PlayPreparePhase;
  dirtyNames: readonly string[];
};

export function PlayPrepareDialog({
  open,
  phase,
  dirtyNames,
}: PlayPrepareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="play-prepare-dialog"
      >
        <DialogHeader>
          <DialogTitle>Saving and compiling</DialogTitle>
          <DialogDescription>
            Preview waits until pending documents are saved and graphs are
            compiled.
          </DialogDescription>
        </DialogHeader>
        {dirtyNames.length > 0 ? (
          <ul className="list-disc pl-5 text-sm">
            {dirtyNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : null}
        <p data-testid="play-prepare-phase" className="text-sm text-muted-foreground">
          {phase === "saving" ? "Saving…" : "Compiling…"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
