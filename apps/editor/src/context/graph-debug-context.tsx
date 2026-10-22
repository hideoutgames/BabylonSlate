import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, ANIM_OBJECT_DEBUG_GRAPH_ID, type DebugObserveTarget } from "@haptic/bridge";
import type { GraphRunTrace } from "@haptic/graph-ui";
import { createBehaviourTreeRunTrace, createGraphRunTrace } from "../lib/graph-run-trace";
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
const noTarget = (): DebugObserveTarget | null => null;

/** The instance list and followed instance; re-renders only when one of them changes. */
export function useGraphDebugSnapshot(): GraphDebugSnapshot | null {
  const store = useGraphDebugStore();
  return useSyncExternalStore(store?.subscribe ?? noStore, store?.getSnapshot ?? noSnapshot);
}

/**
 * What the debugger watches, or null when no Simulation debugs the focused graph. Unlike the
 * snapshot it changes only with the target, so a graph canvas that gates its run trace on it does
 * not render again as instances spawn and despawn.
 */
export function useGraphDebugTarget(): DebugObserveTarget | null {
  const store = useGraphDebugStore();
  return useSyncExternalStore(store?.subscribe ?? noStore, store ? () => store.getSnapshot().target : noTarget);
}

/**
 * What a canvas draws of the running Simulation is `create(store)`, but only while the debugger
 * watches the target `follows` accepts (no Simulation, or another graph in focus, means none), so
 * editing a graph outside a Simulation shows no flash and no tip.
 */
function useRunTrace(
  follows: (target: DebugObserveTarget) => boolean,
  create: (store: GraphDebugStore) => GraphRunTrace,
  dependencies: readonly unknown[],
): GraphRunTrace | undefined {
  const store = useGraphDebugStore();
  const target = useGraphDebugTarget();
  const following = target !== null && follows(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the callers list what `follows` and `create` read.
  return useMemo(() => store && following ? create(store) : undefined, [store, following, ...dependencies]);
}

/** A Class graph canvas: the runs of the followed instance of `classId` in this graph. */
export function useClassGraphRunTrace(
  assetPath: string | undefined,
  classId: string | undefined,
  graphId: string,
): GraphRunTrace | undefined {
  return useRunTrace(
    (target) => assetPath !== undefined && target.kind === "class" && target.classId === classId,
    (store) => createGraphRunTrace(store, assetPath!, graphId),
    [assetPath, classId, graphId],
  );
}

/** A Behaviour Tree canvas: the nodes and links the followed tree ran, and each node's status. */
export function useBehaviourTreeRunTrace(treeGuid: string | undefined): GraphRunTrace | undefined {
  return useRunTrace(
    (target) => treeGuid !== undefined && target.kind === "behaviourTree" && target.assetGuid === treeGuid,
    (store) => createBehaviourTreeRunTrace(store, treeGuid!),
    [treeGuid],
  );
}

/** An Animation Graph's State Machine canvas: the states the followed instance samples and the transitions it takes. */
export function useAnimStateMachineRunTrace(graphGuid: string | undefined): GraphRunTrace | undefined {
  return useRunTrace(
    (target) => graphGuid !== undefined && target.kind === "animationGraph" && target.assetGuid === graphGuid,
    (store) => createGraphRunTrace(store, graphGuid!, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID),
    [graphGuid],
  );
}

/** An Animation Graph's Animation Object canvas, a compiled graph named by the asset's path. */
export function useAnimObjectGraphRunTrace(assetPath: string | undefined, graphGuid: string | undefined): GraphRunTrace | undefined {
  return useRunTrace(
    (target) => assetPath !== undefined && graphGuid !== undefined && target.kind === "animationGraph" && target.assetGuid === graphGuid,
    (store) => createGraphRunTrace(store, assetPath!, ANIM_OBJECT_DEBUG_GRAPH_ID),
    [assetPath, graphGuid],
  );
}
