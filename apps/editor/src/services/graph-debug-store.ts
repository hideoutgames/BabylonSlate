import { sameDebugObserveTarget, type DebugGraphTrace, type DebugInstance, type DebugObserveTarget } from "@haptic/bridge";
import { btNodeStatuses, type BtNodeStatus } from "@haptic/behaviour-tree";

/** What the editor asks the running Simulation to watch. */
export type GraphDebugRequest = {
  target: DebugObserveTarget | null;
  /** The followed instance's id; null follows none. */
  instanceId: string | null;
};

/** The part of the debugger React draws: the target's instance list and which one is followed. */
export type GraphDebugSnapshot = {
  target: DebugObserveTarget | null;
  /** Null until the runtime has listed the target's instances. */
  instances: readonly DebugInstance[] | null;
  /** The followed instance, or null for None. */
  selectedId: string | null;
};

/** One tick of what the followed instance ran. */
export type GraphDebugTrace = {
  instanceId: string;
  tickIndex: number;
  graphs: readonly DebugGraphTrace[];
};

/** The live state of the followed Behaviour Tree, as its `btState` reports it. */
export type GraphDebugBtState = {
  instanceId: string;
  btNodeId: string | null;
  lastResults: Readonly<Record<string, string>>;
  stack: ReadonlyArray<{ nodeId: string }>;
  blackboard: Readonly<Record<string, unknown>>;
};

const EMPTY: GraphDebugSnapshot = { target: null, instances: null, selectedId: null };

function valueKey(assetGuid: string, graphId: string, nodeId: string, pinId: string, direction: "in" | "out"): string {
  return `${assetGuid}\0${graphId}\0${nodeId}\0${pinId}\0${direction}`;
}

/**
 * The editor's graph debugger state for a running Simulation, outside React so a trace
 * arriving every tick never re-renders anything. Three kinds of readers:
 *
 * - The instance list and the followed instance change rarely and feed React through
 *   `subscribe` / `getSnapshot` (the toolbar's instance select).
 * - Execution traces go straight to `subscribeTrace` listeners, which draw into the DOM
 *   themselves (graph canvases), and the latest value of each pin stays readable through `value`.
 * - A followed Behaviour Tree's `btState` becomes each node's status and the Blackboard's
 *   values. A node subscribes to its own status (`subscribeStatus`), so a change renders that
 *   node alone; the Blackboard panel subscribes to the values.
 *
 * The followed instance defaults to the first one listed, falls back to the first remaining
 * one when it despawns, and is None when there are none. A user's pick of None sticks until
 * the target changes. The store asks the runtime to follow it through `subscribeRequest`.
 * Graph kinds that debug other instances reuse it by observing a different target.
 */
export class GraphDebugStore {
  private snapshot: GraphDebugSnapshot = EMPTY;
  /** Live instances by id, in the order the runtime listed them. */
  private roster = new Map<string, DebugInstance>();
  /** The user chose None: a new spawn no longer takes over. */
  private chosenNone = false;
  private values = new Map<string, string>();
  /** The followed Behaviour Tree's node statuses, and the Blackboard it last reported. */
  private statuses = new Map<string, BtNodeStatus>();
  private blackboardValues: Readonly<Record<string, unknown>> | null = null;
  private readonly statusListeners = new Map<string, Set<() => void>>();
  private readonly blackboardListeners = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private readonly traceListeners = new Set<(trace: GraphDebugTrace) => void>();
  private readonly requestListeners = new Set<(request: GraphDebugRequest) => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): GraphDebugSnapshot => this.snapshot;

  /** Traces of the followed instance, as they arrive. The listener must not render React state per call. */
  subscribeTrace(listener: (trace: GraphDebugTrace) => void): () => void {
    this.traceListeners.add(listener);
    return () => { this.traceListeners.delete(listener); };
  }

  /** What to ask the runtime to watch. Called at once with the current request when there is a target. */
  subscribeRequest(listener: (request: GraphDebugRequest) => void): () => void {
    this.requestListeners.add(listener);
    if (this.snapshot.target) listener(this.request());
    return () => { this.requestListeners.delete(listener); };
  }

  /** The latest text of one pin of the followed instance, or undefined before a node has run. */
  value(assetGuid: string, graphId: string, nodeId: string, pinId: string, direction: "in" | "out"): string | undefined {
    return this.values.get(valueKey(assetGuid, graphId, nodeId, pinId, direction));
  }

  /** The status of a node of the followed instance of the Behaviour Tree `assetGuid`, or undefined before it has one. */
  status(assetGuid: string, nodeId: string): BtNodeStatus | undefined {
    const { target } = this.snapshot;
    return target?.kind === "behaviourTree" && target.assetGuid === assetGuid ? this.statuses.get(nodeId) : undefined;
  }

  /** Calls `listener` when that node's status changes. */
  subscribeStatus(nodeId: string, listener: () => void): () => void {
    let listeners = this.statusListeners.get(nodeId);
    if (!listeners) this.statusListeners.set(nodeId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.statusListeners.get(nodeId) === listeners) this.statusListeners.delete(nodeId);
    };
  }

  /** The Blackboard of the followed instance of the Behaviour Tree `assetGuid`, or null before it has reported one. */
  blackboard(assetGuid: string): Readonly<Record<string, unknown>> | null {
    const { target } = this.snapshot;
    return target?.kind === "behaviourTree" && target.assetGuid === assetGuid ? this.blackboardValues : null;
  }

  /** Calls `listener` when the Blackboard values change. */
  subscribeBlackboard(listener: () => void): () => void {
    this.blackboardListeners.add(listener);
    return () => { this.blackboardListeners.delete(listener); };
  }

  /** The graph under focus can be debugged against `target`'s instances; null stops. */
  setTarget(target: DebugObserveTarget | null): void {
    if (sameDebugObserveTarget(target, this.snapshot.target)) return;
    this.roster = new Map();
    this.chosenNone = false;
    this.clearLive();
    this.snapshot = target ? { target, instances: null, selectedId: null } : EMPTY;
    this.changed(true);
  }

  /** The user picks an instance, or null for None. */
  select(instanceId: string | null): void {
    const { target, instances, selectedId } = this.snapshot;
    if (!target || instances === null) return;
    if (instanceId !== null && !this.roster.has(instanceId)) return;
    this.chosenNone = instanceId === null;
    if (instanceId === selectedId) return;
    this.clearLive();
    this.snapshot = { target, instances, selectedId: instanceId };
    this.changed(true);
  }

  /** The runtime's `debugRoster`. */
  receiveRoster(message: { target: DebugObserveTarget; reset: boolean; added: readonly DebugInstance[]; removed: readonly string[] }): void {
    const { target, selectedId } = this.snapshot;
    if (!sameDebugObserveTarget(message.target, target)) return;
    if (message.reset) this.roster = new Map();
    for (const id of message.removed) this.roster.delete(id);
    for (const instance of message.added) this.roster.set(instance.id, instance);
    const instances = [...this.roster.values()];
    let next = selectedId;
    // A despawned instance falls back to the first remaining one, whatever the user had picked.
    if (next !== null && !this.roster.has(next)) next = instances[0]?.id ?? null;
    else if (next === null && !this.chosenNone) next = instances[0]?.id ?? null;
    const moved = next !== selectedId;
    if (moved) this.clearLive();
    this.snapshot = { target, instances, selectedId: next };
    this.changed(moved);
  }

  /** The runtime's `executionTrace`. Traces of an instance no longer followed are dropped. */
  receiveTrace(message: { target: DebugObserveTarget; instanceId: string; tickIndex: number; graphs: readonly DebugGraphTrace[] }): void {
    const { target, selectedId } = this.snapshot;
    if (!sameDebugObserveTarget(message.target, target) || message.instanceId !== selectedId) return;
    for (const graph of message.graphs) {
      for (const [nodeId, pinId, direction, text] of graph.values) {
        this.values.set(valueKey(graph.assetGuid, graph.graphId, nodeId, pinId, direction), text);
      }
    }
    const trace: GraphDebugTrace = { instanceId: message.instanceId, tickIndex: message.tickIndex, graphs: message.graphs };
    for (const listener of [...this.traceListeners]) listener(trace);
  }

  /** The `btState` of the followed Behaviour Tree. A message of an instance no longer followed is dropped. */
  receiveBtState(message: GraphDebugBtState): void {
    const { target, selectedId } = this.snapshot;
    if (target?.kind !== "behaviourTree" || message.instanceId !== selectedId) return;
    const next = btNodeStatuses(message);
    const changed: string[] = [];
    for (const [nodeId, status] of next) if (this.statuses.get(nodeId) !== status) changed.push(nodeId);
    for (const nodeId of this.statuses.keys()) if (!next.has(nodeId)) changed.push(nodeId);
    this.statuses = next;
    this.blackboardValues = message.blackboard;
    this.notifyStatuses(changed);
    for (const listener of [...this.blackboardListeners]) listener();
  }

  /** What the followed instance ran and held is forgotten: another instance, or another target, is followed. */
  private clearLive(): void {
    const had = [...this.statuses.keys()];
    const hadBlackboard = this.blackboardValues !== null;
    this.values = new Map();
    this.statuses = new Map();
    this.blackboardValues = null;
    this.notifyStatuses(had);
    if (hadBlackboard) for (const listener of [...this.blackboardListeners]) listener();
  }

  private notifyStatuses(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) for (const listener of [...(this.statusListeners.get(nodeId) ?? [])]) listener();
  }

  private request(): GraphDebugRequest {
    return { target: this.snapshot.target, instanceId: this.snapshot.selectedId };
  }

  /** `request`: the target or the followed instance changed, so the runtime must hear about it. */
  private changed(request: boolean): void {
    for (const listener of [...this.listeners]) listener();
    if (!request) return;
    const message = this.request();
    for (const listener of [...this.requestListeners]) listener(message);
  }
}
