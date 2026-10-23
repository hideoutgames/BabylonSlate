import { sameDebugObserveTarget, type DebugGraphTrace, type DebugInstance, type DebugObserveTarget, type DebugStep } from "@haptic/bridge";
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

/** Where the stepping control stands: one recorded visit of the followed instance. */
export type GraphDebugStepPosition = {
  tickIndex: number;
  /** The visit's place in its tick, from 0. */
  step: number;
  /** The visits recorded in the tick. */
  stepCount: number;
  /** The tick's visits past the runtime's limit were not recorded. */
  truncated: boolean;
  /** The newest visit recorded: Forward from here runs another tick. */
  newest: boolean;
  assetGuid: string;
  graphId: string;
  nodeId: string;
};

/** Ticks of visits kept for the stepping control, and the display text they may hold in all (about 2 MB). */
export const STEP_HISTORY_TICKS = 8;
const STEP_HISTORY_CHARS = 1_000_000;

type StepTick = {
  tickIndex: number;
  graphs: ReadonlyArray<{ assetGuid: string; graphId: string }>;
  steps: readonly DebugStep[];
  truncated: boolean;
  chars: number;
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
 *   The followed instance's variables stay readable through `variable`; `subscribeValues` hears
 *   about both (the Watches window).
 * - While paused, the stepping control reviews the visits of the last few ticks (`stepBack`,
 *   `stepForward`): `value` then answers as of that visit, and trace listeners get the path up to it.
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
  private variables = new Map<string, string>();
  private readonly valueListeners = new Set<() => void>();
  /** The followed Behaviour Tree's node statuses, and the Blackboard it last reported. */
  private statuses = new Map<string, BtNodeStatus>();
  private blackboardValues: Readonly<Record<string, unknown>> | null = null;
  private readonly statusListeners = new Map<string, Set<() => void>>();
  private readonly blackboardListeners = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private readonly traceListeners = new Set<(trace: GraphDebugTrace) => void>();
  private readonly requestListeners = new Set<(request: GraphDebugRequest) => void>();
  /** The Simulation is paused: canvases keep what ran last lit. */
  private held = false;
  private readonly holdListeners = new Set<(held: boolean) => void>();
  /** An object to follow as soon as a roster lists it (the one a breakpoint stopped on). */
  private pendingFollow: string | null = null;
  /** The followed instance's recent ticks of visits, oldest first, and the one under review. */
  private stepTicks: StepTick[] = [];
  private review: { tick: number; step: number } | null = null;
  /** Pin texts as of the reviewed visit; null shows the live ones. */
  private reviewValues: Map<string, string> | null = null;
  /** Forward ran a tick: review its first visit when its trace arrives. */
  private continueNext = false;

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
    return (this.reviewValues ?? this.values).get(valueKey(assetGuid, graphId, nodeId, pinId, direction));
  }

  /** The visit under review, or null while showing the live run. */
  stepPosition(): GraphDebugStepPosition | null {
    const review = this.review;
    const tick = review && this.stepTicks[review.tick];
    const step = review && tick?.steps[review.step];
    if (!review || !tick || !step) return null;
    const graph = tick.graphs[step[0]]!;
    return {
      tickIndex: tick.tickIndex,
      step: review.step,
      stepCount: tick.steps.length,
      truncated: tick.truncated,
      newest: review.tick === this.stepTicks.length - 1 && review.step === tick.steps.length - 1,
      assetGuid: graph.assetGuid,
      graphId: graph.graphId,
      nodeId: step[1],
    };
  }

  /** Reviews the visit before this one, or the newest one recorded; false when there is none earlier. */
  stepBack(): boolean {
    const newest = this.stepTicks.length - 1;
    if (newest < 0) return false;
    let { tick, step } = this.review ?? { tick: newest, step: this.stepTicks[newest]!.steps.length };
    step -= 1;
    if (step < 0) {
      if (tick === 0) return false;
      tick -= 1;
      step = this.stepTicks[tick]!.steps.length - 1;
    }
    this.moveTo({ tick, step });
    return true;
  }

  /** Reviews the next visit; `atNewest` when none is recorded yet, so another tick must run. */
  stepForward(): "moved" | "atNewest" {
    if (!this.review) return "atNewest";
    let { tick, step } = this.review;
    step += 1;
    if (step >= this.stepTicks[tick]!.steps.length) {
      if (tick === this.stepTicks.length - 1) return "atNewest";
      tick += 1;
      step = 0;
    }
    this.moveTo({ tick, step });
    return "moved";
  }

  /** Forward from the newest visit: the next trace's first visit is reviewed when it arrives. */
  continueIntoNextTick(): void {
    this.continueNext = true;
  }

  /** The latest text of the followed instance's variable `name`, or undefined before the runtime reported it. */
  variable(name: string): string | undefined {
    return this.variables.get(name);
  }

  /**
   * Calls `listener` after a trace or a variables report of the followed instance arrives, and when the values
   * are forgotten. At most once per tick while a Simulation runs: the listener must compare before it renders.
   */
  subscribeValues(listener: () => void): () => void {
    this.valueListeners.add(listener);
    return () => { this.valueListeners.delete(listener); };
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

  /** Whether the Simulation is paused. Called at once with the current state, then on each change. */
  subscribeHold(listener: (held: boolean) => void): () => void {
    this.holdListeners.add(listener);
    listener(this.held);
    return () => { this.holdListeners.delete(listener); };
  }

  /** The Simulation paused or resumed; while paused, canvases keep what ran last lit. */
  setHeld(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    if (!held) this.endReview();
    for (const listener of [...this.holdListeners]) listener(held);
  }

  /**
   * Follow `instanceId` now if the current target lists it, else as soon as a roster does (the
   * graph a breakpoint opened may not be in focus yet). An object a roster never lists, such as an
   * instance of a subclass hitting its parent's graph, is never followed.
   */
  follow(instanceId: string): void {
    this.pendingFollow = instanceId;
    if (this.roster.has(instanceId)) this.select(instanceId);
  }

  /** The user picks an instance, or null for None. */
  select(instanceId: string | null): void {
    this.pendingFollow = null;
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
    if (this.pendingFollow !== null && this.roster.has(this.pendingFollow)) {
      next = this.pendingFollow;
      this.pendingFollow = null;
      this.chosenNone = false;
    // A despawned instance falls back to the first remaining one, whatever the user had picked.
    } else if (next !== null && !this.roster.has(next)) next = instances[0]?.id ?? null;
    else if (next === null && !this.chosenNone) next = instances[0]?.id ?? null;
    const moved = next !== selectedId;
    if (moved) this.clearLive();
    this.snapshot = { target, instances, selectedId: next };
    this.changed(moved);
  }

  /**
   * The runtime's `executionTrace`. Traces of an instance no longer followed are dropped. A tick that ran
   * ends a review, unless Forward ran it: then its first visit is reviewed.
   */
  receiveTrace(message: {
    target: DebugObserveTarget;
    instanceId: string;
    tickIndex: number;
    graphs: readonly DebugGraphTrace[];
    steps?: readonly DebugStep[];
    stepsTruncated?: boolean;
  }): void {
    const { target, selectedId } = this.snapshot;
    if (!sameDebugObserveTarget(message.target, target) || message.instanceId !== selectedId) return;
    for (const graph of message.graphs) {
      for (const [nodeId, pinId, direction, text] of graph.values) {
        this.values.set(valueKey(graph.assetGuid, graph.graphId, nodeId, pinId, direction), text);
      }
    }
    const steps = message.steps ?? [];
    if (steps.length > 0) this.keepSteps(message.tickIndex, message.graphs, steps, message.stepsTruncated === true);
    const trace: GraphDebugTrace = { instanceId: message.instanceId, tickIndex: message.tickIndex, graphs: message.graphs };
    for (const listener of [...this.traceListeners]) listener(trace);
    const continuing = this.continueNext;
    this.continueNext = false;
    this.review = null;
    this.reviewValues = null;
    if (continuing && steps.length > 0) this.moveTo({ tick: this.stepTicks.length - 1, step: 0 });
    else this.notifyValues();
  }

  /** The runtime's `debugVariables`. A report of an instance no longer followed is dropped. */
  receiveVariables(message: { target: DebugObserveTarget; instanceId: string; tickIndex: number; values: ReadonlyArray<readonly [string, string]> }): void {
    const { target, selectedId } = this.snapshot;
    if (!sameDebugObserveTarget(message.target, target) || message.instanceId !== selectedId) return;
    for (const [name, text] of message.values) this.variables.set(name, text);
    this.notifyValues();
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

  /**
   * What the followed instance ran and held is forgotten: another instance, or another target, is
   * followed. Its path no longer stays lit: while paused, the hold is released and taken again.
   */
  private clearLive(): void {
    if (this.held) for (const listener of [...this.holdListeners]) { listener(false); listener(true); }
    this.stepTicks = [];
    this.review = null;
    this.reviewValues = null;
    this.continueNext = false;
    const had = [...this.statuses.keys()];
    const hadBlackboard = this.blackboardValues !== null;
    const hadValues = this.values.size > 0 || this.variables.size > 0;
    this.values = new Map();
    this.variables = new Map();
    this.statuses = new Map();
    this.blackboardValues = null;
    this.notifyStatuses(had);
    if (hadBlackboard) for (const listener of [...this.blackboardListeners]) listener();
    if (hadValues) this.notifyValues();
  }

  private notifyValues(): void {
    for (const listener of [...this.valueListeners]) listener();
  }

  /** Keeps a tick's visits, dropping the oldest ticks past the count or text budget (the newest always stays). */
  private keepSteps(tickIndex: number, graphs: readonly DebugGraphTrace[], steps: readonly DebugStep[], truncated: boolean): void {
    let chars = 0;
    for (const [, nodeId, via, values] of steps) {
      chars += nodeId.length + (via?.length ?? 0);
      for (const [valueNode, pinId, , text] of values) chars += valueNode.length + pinId.length + text.length;
    }
    this.stepTicks.push({ tickIndex, graphs: graphs.map(({ assetGuid, graphId }) => ({ assetGuid, graphId })), steps, truncated, chars });
    let total = this.stepTicks.reduce((sum, tick) => sum + tick.chars, 0);
    while (this.stepTicks.length > 1 && (this.stepTicks.length > STEP_HISTORY_TICKS || total > STEP_HISTORY_CHARS)) {
      total -= this.stepTicks.shift()!.chars;
    }
  }

  /** Reviews one recorded visit: pin texts as of it, and the tick's path up to it for the canvases. */
  private moveTo(position: { tick: number; step: number }): void {
    this.review = position;
    const values = new Map<string, string>();
    for (let index = 0; index <= position.tick; index++) {
      const { graphs, steps } = this.stepTicks[index]!;
      const last = index === position.tick ? position.step : steps.length - 1;
      for (let step = 0; step <= last; step++) {
        const [graphIndex, , , stepValues] = steps[step]!;
        const graph = graphs[graphIndex]!;
        for (const [nodeId, pinId, direction, text] of stepValues) {
          values.set(valueKey(graph.assetGuid, graph.graphId, nodeId, pinId, direction), text);
        }
      }
    }
    this.reviewValues = values;
    // The canvases let the path they hold go, then hold the one up to this visit.
    if (this.held) for (const listener of [...this.holdListeners]) { listener(false); listener(true); }
    const tick = this.stepTicks[position.tick]!;
    const paths = new Map<number, { nodes: Set<string>; edges: Set<string> }>();
    for (const [graphIndex, nodeId, via] of tick.steps.slice(0, position.step + 1)) {
      let path = paths.get(graphIndex);
      if (!path) paths.set(graphIndex, path = { nodes: new Set(), edges: new Set() });
      path.nodes.add(nodeId);
      if (via !== null) path.edges.add(via);
    }
    const trace: GraphDebugTrace = {
      instanceId: this.snapshot.selectedId ?? "",
      tickIndex: tick.tickIndex,
      graphs: [...paths].map(([graphIndex, { nodes, edges }]) => ({
        ...tick.graphs[graphIndex]!, nodes: [...nodes], edges: [...edges], values: [],
      })),
    };
    for (const listener of [...this.traceListeners]) listener(trace);
    this.notifyValues();
  }

  /** Back to the live run: the canvases keep what the last tick ran. */
  private endReview(): void {
    this.continueNext = false;
    if (!this.review) return;
    this.review = null;
    this.reviewValues = null;
    this.notifyValues();
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
