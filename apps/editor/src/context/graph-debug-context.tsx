import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GraphRunTrace } from "@babylonslate/graph-ui";
import { createGraphRunTrace } from "../lib/graph-run-trace";
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

/**
 * What a Class graph canvas draws of the running Simulation: the runs of the followed instance
 * of `classId` in this graph. Undefined while the debugger follows no target of that class (no
 * Simulation, or another graph in focus), so editing a graph outside a Simulation shows no
 * flash and no pin tip.
 */
export function useClassGraphRunTrace(
  assetPath: string | undefined,
  classId: string | undefined,
  graphId: string,
): GraphRunTrace | undefined {
  const store = useGraphDebugStore();
  const target = useGraphDebugSnapshot()?.target;
  const followsClass = target?.kind === "class" && target.classId === classId;
  return useMemo(
    () => store && assetPath !== undefined && followsClass ? createGraphRunTrace(store, assetPath, graphId) : undefined,
    [store, assetPath, followsClass, graphId],
  );
}
