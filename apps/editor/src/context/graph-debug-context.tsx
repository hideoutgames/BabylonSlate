import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DebugObserveTarget } from "@babylonslate/bridge";
import { GraphDebugStore, type GraphDebugSnapshot } from "../services/graph-debug-store";

const GraphDebugContext = createContext<GraphDebugStore | null>(null);

/**
 * Owns the graph debugger's state for the running Simulation. The store sits outside React
 * state, so a trace arriving every tick wakes only the readers that asked for it.
 */
export function GraphDebugProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new GraphDebugStore());
  return <GraphDebugContext.Provider value={store}>{children}</GraphDebugContext.Provider>;
}

/** The store, or null outside a provider (tests, isolated panels). */
export function useGraphDebugStore(): GraphDebugStore | null {
  return useContext(GraphDebugContext);
}

const noStore = () => () => {};
const noSnapshot = (): GraphDebugSnapshot | null => null;

/** The instance list and followed instance; re-renders only when one of them changes. */
export function useGraphDebugSnapshot(): GraphDebugSnapshot | null {
  const store = useGraphDebugStore();
  return useSyncExternalStore(store?.subscribe ?? noStore, store?.getSnapshot ?? noSnapshot);
}

const noTarget = (): DebugObserveTarget | null => null;

/**
 * What the debugger watches, or null when no Simulation debugs the focused graph. Unlike the
 * snapshot it changes only with the target, so a graph canvas that gates its run trace on it does
 * not render again as instances spawn and despawn.
 */
export function useGraphDebugTarget(): DebugObserveTarget | null {
  const store = useGraphDebugStore();
  return useSyncExternalStore(store?.subscribe ?? noStore, store ? () => store.getSnapshot().target : noTarget);
}
