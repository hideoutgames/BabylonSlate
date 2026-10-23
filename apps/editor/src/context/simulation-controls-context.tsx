import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SessionPauseCause } from "@haptic/bridge";

/**
 * What the global toolbar shows and drives for the running Simulation, or for editor Play while it
 * is stopped at a breakpoint or an error with its view hidden (`mode: "play"`: Resume and Stop only).
 */
export interface SimulationControls {
  mode: "simulate" | "play";
  paused: boolean;
  pausePending: boolean;
  /** A Step is running its tick; the next waits for it. */
  stepPending: boolean;
  inputMode: "game" | "edit";
  inputPending: boolean;
  keepChanges: boolean;
  /** The breakpoint the session stopped at, until it resumes. */
  stoppedAt: SessionPauseCause | null;
  togglePause: () => void;
  /** While paused: run one tick and stay paused. */
  step: () => void;
  setInputMode: (mode: "game" | "edit") => void;
}

/**
 * The Play overlay owns pause and input mode; the global toolbar presents
 * them. A store rather than context value keeps a pause from re-rendering
 * every Play consumer.
 */
class SimulationControlsStore {
  private controls: SimulationControls | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.controls;

  publish(controls: SimulationControls | null) {
    if (this.controls === controls) return;
    this.controls = controls;
    for (const listener of [...this.listeners]) listener();
  }
}

const SimulationControlsContext = createContext<SimulationControlsStore | null>(null);

export function SimulationControlsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SimulationControlsStore());
  return (
    <SimulationControlsContext.Provider value={store}>
      {children}
    </SimulationControlsContext.Provider>
  );
}

const noStore = () => () => {};
const noControls = () => null;

/** The running Simulation's controls, or null without one. */
export function useSimulationControls(): SimulationControls | null {
  const store = useContext(SimulationControlsContext);
  return useSyncExternalStore(
    store?.subscribe ?? noStore,
    store?.getSnapshot ?? noControls,
  );
}

/** Publishes `controls` while mounted; null withdraws them. */
export function usePublishSimulationControls(controls: SimulationControls | null): void {
  const store = useContext(SimulationControlsContext);
  useLayoutEffect(() => {
    store?.publish(controls);
  }, [store, controls]);
  useLayoutEffect(() => () => store?.publish(null), [store]);
}

/** Marks toolbar controls that act on the Simulation without releasing game input first. */
export const SIMULATION_CONTROL_ATTRIBUTE = "data-simulation-control";
