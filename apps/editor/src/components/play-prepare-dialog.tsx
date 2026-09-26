import { useEffect, useState } from "react";
import { ClockIcon, PlayIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
} from "@babylonslate/ui/components/dialog";
import { Badge } from "@babylonslate/ui/components/badge";
import { ProgressDialogHeader, ProgressStepList } from "./progress-dialog-parts";

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
  const steps = [
    {
      key: "save",
      label: dirtyNames.length > 0
        ? `Save ${dirtyNames.length} ${dirtyNames.length === 1 ? "Document" : "Documents"}`
        : "Save Documents",
      detail: dirtyNames.length > 0 ? (
        <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
          {dirtyNames.map((name) => (
            <li key={name} className="max-w-full">
              <Badge variant="outline" className="max-w-full font-normal text-muted-foreground">
                <span className="truncate">{name}</span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null,
    },
    { key: "compile", label: "Compile Graphs" },
  ];
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        data-testid="play-prepare-dialog"
      >
        <ProgressDialogHeader
          icon={PlayIcon}
          title="Preparing Play"
          description="Play starts once pending documents are saved and graphs are compiled."
        />
        <ProgressStepList steps={steps} current={phase === "saving" ? 0 : 1} className="pl-2.5" />
        {takingLonger ? (
          <p role="status" className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <ClockIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            Taking longer than usual. Large documents can take more time. Keep the editor open while saving and compiling finishes.
          </p>
        ) : null}
        <p role="status" data-testid="play-prepare-phase" className="sr-only">
          {phase === "saving" ? "Saving…" : "Compiling…"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
