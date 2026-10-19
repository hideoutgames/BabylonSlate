import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
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
