import { useEffect, useState } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { Dialog } from "@babylonslate/ui/components/dialog";
import { ProgressDialogContent, ProgressDialogStatus } from "./progress-dialog-parts";

export type PlayPreparePhase = "saving" | "compiling" | "releasing";

export type PlayPrepareDialogProps = {
  open: boolean;
  phase: PlayPreparePhase;
  dirtyNames: readonly string[];
  title?: string;
  onCancel?: () => void;
};

export function PlayPrepareDialog({
  open,
  phase,
  dirtyNames,
  title = "Preparing Play",
  onCancel,
}: PlayPrepareDialogProps) {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    if (!open) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 10000);
    return () => window.clearTimeout(timer);
  }, [open]);
  const saving = phase === "saving";
  const names = saving ? dirtyNames.join(", ") : "";
  const label = phase === "releasing" ? "Releasing Authoring View" : !saving
    ? "Compiling Graphs"
    : dirtyNames.length > 0
      ? `Saving ${dirtyNames.length} ${dirtyNames.length === 1 ? "Document" : "Documents"}`
      : "Saving Documents";
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <ProgressDialogContent data-testid="play-prepare-dialog">
        <ProgressDialogStatus
          title={title}
          phase={label}
          value={null}
          valueLabel={saving ? "1 / 2" : "2 / 2"}
          detail={names || takingLonger ? (
            <div className="-mt-1 flex flex-col gap-1 pl-5.5 text-xs text-muted-foreground/80">
              {names ? <p className="truncate" title={names}>{names}</p> : null}
              {takingLonger ? (
                <p role="status">Taking longer than usual. Large documents can take more time; keep the editor open.</p>
              ) : null}
            </div>
          ) : null}
        />
        <p role="status" data-testid="play-prepare-phase" className="sr-only">
          {label}
        </p>
        {onCancel ? <div className="flex justify-end"><Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button></div> : null}
      </ProgressDialogContent>
    </Dialog>
  );
}
