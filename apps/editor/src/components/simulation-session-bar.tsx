import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";

/** Session actions remain outside document tabs, drawers, and the virtual keyboard. */
export function SimulationSessionBar({ onReturnToScene, onStop, stopping }: {
  onReturnToScene: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  return (
    <div className="fixed right-3 top-[max(0.5rem,env(safe-area-inset-top))] z-[70] flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
      role="region" aria-label="Simulation Controls" data-testid="simulation-session-bar">
      <SelectableText className="px-1 text-xs">Simulation · Discard On Stop</SelectableText>
      <Button size="sm" variant="outline" onClick={onReturnToScene}>Return To Scene</Button>
      <Button size="sm" variant="secondary" disabled={stopping} onClick={onStop} data-testid="simulation-session-stop">
        {stopping ? "Stopping…" : "Stop Simulation"}
      </Button>
    </div>
  );
}
