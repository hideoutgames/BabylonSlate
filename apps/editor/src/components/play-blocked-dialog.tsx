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
import type { Diagnostic } from "@babylonslate/scripting";
import { SelectableText } from "@babylonslate/editor-kit";

export type PlayBlockedDialogProps = {
  open: boolean;
  diagnostics: Diagnostic[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (d: Diagnostic) => void;
  onPlayAnyway: () => void;
};

export function PlayBlockedDialog({
  open,
  diagnostics,
  onOpenChange,
  onNavigate,
  onPlayAnyway,
}: PlayBlockedDialogProps) {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-h-[85svh] overflow-hidden"
        data-testid="play-blocked-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Compile errors</AlertDialogTitle>
          <AlertDialogDescription>
            Fix errors before Preview, or play anyway. Tap a row to navigate.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {errors.map((d, i) => (
            <button
              key={`${d.code}-${i}`}
              type="button"
              className="min-h-11 rounded-md px-2 py-2 text-left hover:bg-muted"
              data-testid="play-blocked-row"
              onClick={() => onNavigate(d)}
            >
              <SelectableText className="text-sm text-destructive">
                {d.code}: {d.message}
              </SelectableText>
            </button>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="play-anyway"
            onClick={() => {
              onPlayAnyway();
            }}
          >
            Play Anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
