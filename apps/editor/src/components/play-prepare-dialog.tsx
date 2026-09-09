import { useEffect, useState } from "react";
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
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    if (!open) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 10000);
    return () => window.clearTimeout(timer);
  }, [open]);
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
          <ul className="max-h-48 overflow-y-auto list-disc pl-5 text-sm">
            {dirtyNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : null}
        <p role="status" data-testid="play-prepare-phase" className="text-sm text-muted-foreground">
          {phase === "saving" ? "Saving…" : "Compiling…"}
        </p>
        {takingLonger ? (
          <p role="status" className="text-sm text-muted-foreground">
            Taking longer than usual. Large documents can take more time. Keep the editor open while saving and compiling finishes.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
