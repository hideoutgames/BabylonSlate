import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { StepBackIcon, StepForwardIcon } from "lucide-react";
import { Badge } from "@haptic/ui/components/badge";
import type { SimulationControls } from "../context/simulation-controls-context";
import type { GraphDebugStepPosition, GraphDebugStore } from "../services/graph-debug-store";
import { IconActionButton } from "./icon-action-button";

/**
 * The stepping control on a graph canvas while the game is paused: Step Back and Step Forward walk the
 * visits the followed object made, in order and across the last few ticks, showing each with the values
 * its pins had. Step Forward at the newest visit runs one more tick and continues into it. Reviewing never
 * rewinds the game. `onFocus` opens the graph at a visit's node.
 */
export function GraphSteppingBar({ store, controls, onFocus }: {
  store: GraphDebugStore;
  controls: Pick<SimulationControls, "step" | "stepPending">;
  onFocus: (position: GraphDebugStepPosition) => void;
}) {
  const cache = useRef<{ key: string; view: { position: GraphDebugStepPosition | null; recorded: boolean } } | null>(null);
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribeValues = store.subscribeValues(listener);
    const unsubscribeSnapshot = store.subscribe(listener);
    return () => {
      unsubscribeValues();
      unsubscribeSnapshot();
    };
  }, [store]);
  const { position, recorded } = useSyncExternalStore(subscribe, () => {
    const view = { position: store.stepPosition(), recorded: store.hasRecordedSteps() };
    const key = JSON.stringify(view);
    if (cache.current?.key !== key) cache.current = { key, view };
    return cache.current.view;
  });
  // Step Forward ran a tick: open its first visit once its trace arrives.
  const awaitingTick = useRef(false);
  useEffect(() => {
    if (!awaitingTick.current || !position) return;
    awaitingTick.current = false;
    onFocus(position);
  }, [onFocus, position]);

  const back = () => {
    if (!store.stepBack()) return;
    const next = store.stepPosition();
    if (next) onFocus(next);
  };
  const forward = () => {
    if (store.stepForward() === "moved") {
      const next = store.stepPosition();
      if (next) onFocus(next);
      return;
    }
    awaitingTick.current = true;
    store.continueIntoNextTick();
    controls.step();
  };

  const label = position
    ? `Tick ${position.tickIndex} · Step ${position.step + 1} of ${position.stepCount}`
    : recorded ? "Latest Tick" : "Nothing Recorded Yet";
  const cutShort = position?.truncated === true && position.step === position.stepCount - 1;
  return (
    <div role="group" aria-label="Stepping" className="flex items-center gap-1" data-testid="graph-stepping-bar">
      <IconActionButton
        label="Step Back"
        variant="ghost"
        size="touch-icon"
        disabled={position ? position.oldest : !recorded}
        onClick={back}
        data-testid="graph-step-back"
      >
        <StepBackIcon />
      </IconActionButton>
      <span className="px-1 text-xs tabular-nums" data-testid="graph-step-position">{label}</span>
      {position && !position.newest ? <Badge variant="secondary" data-testid="graph-step-past">Past</Badge> : null}
      {cutShort ? <span className="text-xs text-muted-foreground">Later Steps Not Recorded</span> : null}
      <IconActionButton
        label={position && !position.newest ? "Step Forward" : "Step Forward Into The Next Tick"}
        variant="ghost"
        size="touch-icon"
        disabled={controls.stepPending}
        onClick={forward}
        data-testid="graph-step-forward"
      >
        <StepForwardIcon />
      </IconActionButton>
    </div>
  );
}
