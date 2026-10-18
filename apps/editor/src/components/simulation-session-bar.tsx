import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";

/** Session actions remain outside document tabs, drawers, and the virtual keyboard. */
export function SimulationSessionBar({ keepChanges, onReturnToScene, onStop, stopping }: {
  keepChanges: boolean;
  onReturnToScene: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  return (
    <div className="fixed right-3 top-[max(0.5rem,env(safe-area-inset-top))] z-[70] toolbar-island max-w-[calc(100%-1.5rem)] flex-wrap"
      role="region" aria-label="Simulation Controls" data-testid="simulation-session-bar">
      <SelectableText className="px-1 text-xs">Simulation · {keepChanges ? "Keep Changes On Stop" : "Discard On Stop"}</SelectableText>
      <Button size="sm" variant="outline" onClick={onReturnToScene}>Return To Scene</Button>
      <Button size="sm" variant="secondary" disabled={stopping} onClick={onStop} data-testid="simulation-session-stop">
        {stopping ? "Stopping…" : "Stop Simulation"}
      </Button>
    </div>
  );
}
