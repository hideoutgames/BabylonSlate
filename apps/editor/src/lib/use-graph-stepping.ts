import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { SimulationControls } from "../context/simulation-controls-context";
import type { GraphDebugStepPosition, GraphDebugStore } from "../services/graph-debug-store";

export type SteppingControls = Pick<SimulationControls, "step" | "stepPending">;

/** What the stepping control shows and does, for its toolbar buttons and their More Actions menu form. */
export type GraphStepping = {
  position: GraphDebugStepPosition | null;
  /** A tick's visits are recorded, so Step Back has somewhere to go from the live view. */
  recorded: boolean;
  canStepBack: boolean;
  /** Step Forward moves within the recorded visits rather than running the next tick. */
  forwardInRecord: boolean;
  label: string;
  /** The visit shown is the last one its tick recorded, and the runtime's limit cut later ones. */
  cutShort: boolean;
  stepBack: () => void;
  stepForward: () => void;
};

/**
 * Step Back and Step Forward walk the visits the followed object made, in order and across the last few
 * ticks, showing each with the values its pins had. Step Forward at the newest visit runs one more tick and
 * continues into it. Reviewing never rewinds the game. `onFocus` opens the graph at a visit's node.
 */
export function useGraphStepping(
  store: GraphDebugStore,
  controls: SteppingControls,
  onFocus: (position: GraphDebugStepPosition) => void,
): GraphStepping {
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

  const stepBack = () => {
    if (!store.stepBack()) return;
    const next = store.stepPosition();
    if (next) onFocus(next);
  };
  const stepForward = () => {
    if (store.stepForward() === "moved") {
      const next = store.stepPosition();
      if (next) onFocus(next);
      return;
    }
    awaitingTick.current = true;
    store.continueIntoNextTick();
    controls.step();
  };

  return {
    position,
    recorded,
    canStepBack: position ? !position.oldest : recorded,
    forwardInRecord: position !== null && !position.newest,
    label: position
      ? `Tick ${position.tickIndex} · Step ${position.step + 1} of ${position.stepCount}`
      : recorded ? "Latest Tick" : "Nothing Recorded Yet",
    cutShort: position?.truncated === true && position.step === position.stepCount - 1,
    stepBack,
    stepForward,
  };
}
