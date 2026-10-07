import { useSyncExternalStore } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import type { SimulationSession } from "../services/simulation-session";

export function SimulationRetentionDialog({ session, onStop }: { session: SimulationSession; onStop: () => void }) {
  const state = useSyncExternalStore(session.subscribeRetention, session.getRetention, session.getRetention);
  return <AlertDialog open={state.status === "failed"} onOpenChange={() => {}}>
    <AlertDialogContent data-testid="simulation-retention-resolution">
      <AlertDialogHeader><AlertDialogTitle>Simulation Changes Could Not Be Kept</AlertDialogTitle>
        <AlertDialogDescription>{state.reason}</AlertDialogDescription></AlertDialogHeader>
      <p className="text-sm text-muted-foreground">The authored Scene is unchanged. Retry after resolving the problem, or discard the Simulation changes and stop.</p>
      <AlertDialogFooter>
        <Button size="sm" variant="outline" onClick={() => { session.discardChanges(); onStop(); }}>Discard Changes And Stop</Button>
        <Button size="sm" onClick={onStop}>Retry Keep</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function SimulationRetentionHint({ session }: { session: SimulationSession }) {
  const state = useSyncExternalStore(session.subscribeRetention, session.getRetention, session.getRetention);
  return session.keepChanges && state.unavailableReason
    ? <p role="status" className="pointer-events-auto text-xs text-destructive">Keep unavailable: {state.unavailableReason}</p>
    : state.status === "capturing" ? <p role="status" className="text-xs text-muted-foreground">Capturing the final Scene…</p> : null;
}
