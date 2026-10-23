import type {
  CommandMessage,
  DebugGraphTrace,
  DebugInstance,
  DebugObserveTarget,
  DebugStep,
} from "@haptic/bridge";
import { sameDebugObserveTarget } from "@haptic/bridge";
import { formatValue } from "@haptic/core";
import { BObject, type Actor, type World } from "@haptic/object-model";
import { animGraphGuidOf, behaviourTreeGuidOf, evaluatedBehaviourTreeComponent } from "./component-assets";
import { componentOwners } from "./world-component-index";

/**
 * Graph debugging for the editor's Simulation. A debug-instrumented script
 * reaches the recorder of the one instance the editor follows through
 * `ctx.debugTrace`; every other instance gets null and pays a null check per
 * probe. The Behaviour Tree and Animation Graph runtimes report the graphs they
 * evaluate themselves into the same recorder. The recorder gathers what ran
 * during a tick; `ScriptDebugObserver` sends it, and the live instance roster,
 * at the end of the tick.
 */


/** What a debug-instrumented graph reports while it runs for the followed instance. */
export interface ScriptGraphRecorder {
  /** An exec node ran. */
  exec(nodeId: string): void;
  /** An exec wire was taken. */
  edge(edgeId: string): void;
  /** A node read this value from a data input; returns it unchanged. */
  read<T>(nodeId: string, pinId: string, value: T): T;
  /** A node produced this value on a data output. */
  write(nodeId: string, pinId: string, value: unknown): void;
}

/** `ctx.debugTrace`: null for every instance but the followed one. */
export interface ScriptDebugTrace {
  /** The recorder for one graph of one asset, or null once the observation has ended. */
  graph(assetGuid: string, graphId: string): ScriptGraphRecorder | null;
}

/** Longest value text sent to the editor, as in the trace snapshot preview. */
export const DEBUG_VALUE_MAX_CHARS = 100;
/** Entries of a collection shown before it is cut off. */
const DEBUG_VALUE_MAX_ENTRIES = 16;
const DEBUG_VALUE_MAX_DEPTH = 4;
/** The most live instances a roster lists. */
export const DEBUG_ROSTER_LIMIT = 128;

/** Four decimals with float noise and -0 shown as 0, like the console's readback. */
function roundForDisplay(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 || 0 : value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A bounded copy of `value` whose numbers are rounded and whose objects are references, ready for `formatValue`. */
function displayable(value: unknown, depth: number): unknown {
  if (typeof value === "number") return roundForDisplay(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof BObject) return { guid: value.guid, classId: value.classId };
  if (depth >= DEBUG_VALUE_MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    const shown = value.slice(0, DEBUG_VALUE_MAX_ENTRIES).map((entry) => displayable(entry, depth + 1));
    if (value.length > DEBUG_VALUE_MAX_ENTRIES) shown.push("…");
    return shown;
  }
  if (value instanceof Map) {
    const shown = new Map<unknown, unknown>();
    for (const [key, entry] of value) {
      if (shown.size === DEBUG_VALUE_MAX_ENTRIES) {
        shown.set("…", "…");
        break;
      }
      shown.set(displayable(key, depth + 1), displayable(entry, depth + 1));
    }
    return shown;
  }
  if (isPlainObject(value)) {
    const shown: Record<string, unknown> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, DEBUG_VALUE_MAX_ENTRIES)) shown[key] = displayable(value[key], depth + 1);
    if (keys.length > DEBUG_VALUE_MAX_ENTRIES) shown["…"] = "…";
    return shown;
  }
  return `[${value.constructor?.name ?? "Object"}]`;
}

/** The text the editor shows for a value a node read or produced. */
export function formatDebugValue(value: unknown): string {
  const text = formatValue(displayable(value, 0));
  return text.length > DEBUG_VALUE_MAX_CHARS ? `${text.slice(0, DEBUG_VALUE_MAX_CHARS)}…` : text;
}

/** One data pin's latest value this tick, reused across ticks so recording allocates nothing after the first run. */
type PinSlot = {
  nodeId: string;
  pinId: string;
  direction: "in" | "out";
  /** A primitive as recorded, else its display text taken at the time (a later node may mutate the object). */
  value: unknown;
  pending: boolean;
  /** The text last sent, so an unchanged value is not sent again. */
  sent: string | undefined;
};

/** Visits a tick's steps keep for the stepping control; later visits still light the graph and report values. */
export const DEBUG_STEPS_PER_TICK = 200;
/** Values one step keeps. */
const DEBUG_STEP_VALUES = 32;

/** Where a recorder reports each visit, wire and value in run order, for the steps. */
interface StepLog {
  readonly closed: boolean;
  visit(recorder: GraphRecorder, nodeId: string): void;
  via(recorder: GraphRecorder, edgeId: string): void;
  value(recorder: GraphRecorder, nodeId: string, pinId: string, direction: "in" | "out", value: unknown): void;
}

class GraphRecorder implements ScriptGraphRecorder {
  private readonly nodes = new Set<string>();
  private readonly edges = new Set<string>();
  private readonly inputs = new Map<string, Map<string, PinSlot>>();
  private readonly outputs = new Map<string, Map<string, PinSlot>>();
  private pending: PinSlot[] = [];

  readonly assetGuid: string;
  readonly graphId: string;
  private readonly sink: StepLog;

  constructor(assetGuid: string, graphId: string, sink: StepLog) {
    this.assetGuid = assetGuid;
    this.graphId = graphId;
    this.sink = sink;
  }

  exec(nodeId: string): void {
    if (this.sink.closed) return;
    this.nodes.add(nodeId);
    this.sink.visit(this, nodeId);
  }

  edge(edgeId: string): void {
    if (this.sink.closed) return;
    this.edges.add(edgeId);
    this.sink.via(this, edgeId);
  }

  read<T>(nodeId: string, pinId: string, value: T): T {
    if (!this.sink.closed) this.record(this.inputs, "in", nodeId, pinId, value);
    return value;
  }

  write(nodeId: string, pinId: string, value: unknown): void {
    if (!this.sink.closed) this.record(this.outputs, "out", nodeId, pinId, value);
  }

  private record(
    slots: Map<string, Map<string, PinSlot>>,
    direction: "in" | "out",
    nodeId: string,
    pinId: string,
    value: unknown,
  ): void {
    let byPin = slots.get(nodeId);
    if (!byPin) slots.set(nodeId, byPin = new Map());
    let slot = byPin.get(pinId);
    if (!slot) byPin.set(pinId, slot = { nodeId, pinId, direction, value: undefined, pending: false, sent: undefined });
    slot.value = value === null || typeof value !== "object" ? value : formatDebugValue(value);
    this.sink.value(this, nodeId, pinId, direction, slot.value);
    if (!slot.pending) {
      slot.pending = true;
      this.pending.push(slot);
    }
  }

  /** Everything recorded since the last drain, or null when nothing ran. */
  drain(): DebugGraphTrace | null {
    if (this.nodes.size === 0 && this.edges.size === 0 && this.pending.length === 0) return null;
    const values: DebugGraphTrace["values"] = [];
    for (const slot of this.pending) {
      slot.pending = false;
      const text = formatDebugValue(slot.value);
      slot.value = undefined;
      if (text === slot.sent) continue;
      slot.sent = text;
      values.push([slot.nodeId, slot.pinId, slot.direction, text]);
    }
    this.pending = [];
    const trace: DebugGraphTrace = {
      assetGuid: this.assetGuid,
      graphId: this.graphId,
      nodes: [...this.nodes],
      edges: [...this.edges],
      values,
    };
    this.nodes.clear();
    this.edges.clear();
    return trace;
  }
}

type StepRecord = { recorder: GraphRecorder; nodeId: string; via: string | null; values: DebugGraphTrace["values"] };

/**
 * The recorders of one followed instance. A new follow gets a new sink, so a late run of the old one is ignored.
 * Besides each graph's trace, it keeps the tick's visits in run order across graphs (`drainSteps`).
 */
export class ExecutionTraceSink implements ScriptDebugTrace, StepLog {
  closed = false;
  private readonly recorders = new Map<string, Map<string, GraphRecorder>>();
  private steps: StepRecord[] = [];
  private truncated = false;
  /** Each graph's latest visit this tick: where that graph's values go. */
  private readonly latest = new Map<GraphRecorder, StepRecord>();
  /** A wire taken, for the graph's next visit. */
  private readonly pendingVia = new Map<GraphRecorder, string>();
  /** The text each pin last had in this tick's steps, by graph and `direction node pin`. */
  private readonly stepTexts = new Map<GraphRecorder, Map<string, string>>();

  graph(assetGuid: string, graphId: string): ScriptGraphRecorder | null {
    if (this.closed) return null;
    let byGraph = this.recorders.get(assetGuid);
    if (!byGraph) this.recorders.set(assetGuid, byGraph = new Map());
    let recorder = byGraph.get(graphId);
    if (!recorder) byGraph.set(graphId, recorder = new GraphRecorder(assetGuid, graphId, this));
    return recorder;
  }

  /** @internal */
  visit(recorder: GraphRecorder, nodeId: string): void {
    const via = this.pendingVia.get(recorder) ?? null;
    this.pendingVia.delete(recorder);
    if (this.steps.length >= DEBUG_STEPS_PER_TICK) {
      this.truncated = true;
      this.latest.delete(recorder);
      return;
    }
    const step: StepRecord = { recorder, nodeId, via, values: [] };
    this.steps.push(step);
    this.latest.set(recorder, step);
  }

  /** @internal */
  via(recorder: GraphRecorder, edgeId: string): void {
    this.pendingVia.set(recorder, edgeId);
  }

  /** @internal */
  value(recorder: GraphRecorder, nodeId: string, pinId: string, direction: "in" | "out", value: unknown): void {
    // A value before the graph's first visit of the tick, or after the tick's limit, has no step to join.
    const values = this.latest.get(recorder)?.values;
    if (!values) return;
    const text = formatDebugValue(value);
    let texts = this.stepTexts.get(recorder);
    if (!texts) this.stepTexts.set(recorder, texts = new Map());
    const key = `${direction}\0${nodeId}\0${pinId}`;
    if (texts.get(key) === text) return;
    if (values.length >= DEBUG_STEP_VALUES) {
      this.truncated = true;
      return;
    }
    texts.set(key, text);
    values.push([nodeId, pinId, direction, text]);
  }

  /**
   * The visits since the last call, in run order, each naming its graph by index into `graphs` (this tick's
   * `drain`); null when there were none. Starts the next tick's steps afresh.
   */
  drainSteps(graphs: readonly DebugGraphTrace[]): { steps: DebugStep[]; truncated: boolean } | null {
    const records = this.steps;
    const truncated = this.truncated;
    this.steps = [];
    this.truncated = false;
    this.latest.clear();
    this.pendingVia.clear();
    this.stepTexts.clear();
    const index = new Map(graphs.map((trace, i) => [`${trace.assetGuid}\0${trace.graphId}`, i]));
    const steps: DebugStep[] = [];
    for (const { recorder, nodeId, via, values } of records) {
      const graph = index.get(`${recorder.assetGuid}\0${recorder.graphId}`);
      if (graph !== undefined) steps.push([graph, nodeId, via, values]);
    }
    return steps.length > 0 ? { steps, truncated } : null;
  }

  /** What every graph ran since the last drain. */
  drain(): DebugGraphTrace[] {
    const traces: DebugGraphTrace[] = [];
    for (const byGraph of this.recorders.values()) {
      for (const recorder of byGraph.values()) {
        const trace = recorder.drain();
        if (trace) traces.push(trace);
      }
    }
    return traces;
  }

  close(): void {
    this.closed = true;
    this.recorders.clear();
  }
}

/** An object's name as the Debug Instance list shows it: its `name` variable, else its class. */
export function debugInstanceLabel(object: BObject): string {
  const name = object.variables.get("name");
  return typeof name === "string" && name.length > 0 ? name : object.classId;
}

type InstanceVisitor = (object: BObject, kind: DebugInstance["kind"], owner?: Actor) => boolean | void;

/**
 * The live objects `target` debugs, in world order, until `found` returns true or `limit` objects were
 * visited. A class target lists objects of exactly that class: Game Instance, subsystems, then each actor
 * followed by its components. A Behaviour Tree or Animation Graph target lists the components that run the
 * asset, the tree a component evaluates being its actor's first live Behaviour Tree component.
 */
function collectInstances(world: World, target: DebugObserveTarget, limit: number, found: InstanceVisitor): void {
  let count = 0;
  const visit = (object: BObject, kind: DebugInstance["kind"], owner?: Actor): boolean => {
    count += 1;
    return found(object, kind, owner) === true || count >= limit;
  };
  if (target.kind === "behaviourTree") {
    for (const actor of componentOwners(world, "BehaviourTreeComponent")) {
      const component = actor.destroyed ? undefined : evaluatedBehaviourTreeComponent(actor);
      if (component && behaviourTreeGuidOf(component) === target.assetGuid && visit(component, "component", actor)) return;
    }
    return;
  }
  if (target.kind === "animationGraph") {
    for (const actor of componentOwners(world, "AnimationGraphComponent")) {
      if (actor.destroyed) continue;
      for (const component of actor.components) {
        if (component.classId !== "AnimationGraphComponent" || component.destroyed) continue;
        if (animGraphGuidOf(component) === target.assetGuid && visit(component, "component", actor)) return;
      }
    }
    return;
  }
  const { classId } = target;
  const visitClass = (object: BObject, kind: DebugInstance["kind"], owner?: Actor): boolean =>
    object.classId === classId && !object.destroyed && visit(object, kind, owner);
  if (world.gameInstance && visitClass(world.gameInstance, "gameInstance")) return;
  for (const subsystem of world.getGameSubsystems()) if (visitClass(subsystem, "subsystem")) return;
  for (const subsystem of world.getSceneSubsystems()) if (visitClass(subsystem, "subsystem")) return;
  for (const actor of world.getActors()) {
    if (visitClass(actor, "actor")) return;
    for (const component of actor.components) if (visitClass(component, "component", actor)) return;
  }
}

/** The first live instances of `target`, in world order. */
export function debugInstancesOf(world: World, target: DebugObserveTarget, limit = DEBUG_ROSTER_LIMIT): DebugInstance[] {
  const instances: DebugInstance[] = [];
  collectInstances(world, target, limit, (object, kind, owner) => {
    // A Behaviour Tree or Animation Graph component has no name worth showing: it is the actor's.
    const byClass = target.kind === "class";
    instances.push({
      id: object.guid,
      kind,
      label: debugInstanceLabel(byClass || !owner ? object : owner),
      ...(byClass && owner ? { ownerLabel: debugInstanceLabel(owner) } : {}),
    });
  });
  return instances;
}

function findInstance(world: World, target: DebugObserveTarget, id: string): BObject | null {
  let match: BObject | null = null;
  collectInstances(world, target, Number.MAX_SAFE_INTEGER, (object) => {
    if (object.guid !== id) return false;
    match = object;
    return true;
  });
  return match;
}

/** Whether the live components of a Behaviour Tree or Animation Graph target are the roster last sent, in order. */
function sameComponentRoster(world: World, target: DebugObserveTarget, sent: ReadonlyMap<string, DebugInstance>): boolean {
  const expected = sent.values();
  let same = true;
  let count = 0;
  collectInstances(world, target, DEBUG_ROSTER_LIMIT, (object, _kind, owner) => {
    const before = expected.next();
    if (before.done || before.value.id !== object.guid || before.value.label !== debugInstanceLabel(owner ?? object)) {
      same = false;
      return true;
    }
    count += 1;
  });
  return same && count === sent.size;
}

export interface ScriptDebugObserverHost {
  world(): World;
  emit(command: CommandMessage): void;
  /** Routes `ctx.debugTrace` to `sink` for runs on `object`; null removes it. */
  setDebugTrace(object: BObject | null, sink: ScriptDebugTrace | null): void;
}

/** What the world looked like when the roster was last built. */
type RosterBasis = { revision: number; gameInstance: BObject | null; subsystems: number };

/**
 * Serves the editor's graph debugger: the roster of live instances of the
 * observed target, and the execution trace of the followed one. All of it is
 * off until the editor asks (`debugObserve`) and costs nothing afterwards.
 */
export class ScriptDebugObserver {
  private target: DebugObserveTarget | null = null;
  private followed: BObject | null = null;
  private sink: ExecutionTraceSink | null = null;
  /** The roster last sent, to send only changes. Null before the first send for this target. */
  private sent: Map<string, DebugInstance> | null = null;
  private basis: RosterBasis | null = null;
  /** The followed instance's variable texts last sent, and its variables revision then (NaN: unversioned). */
  private variableTexts = new Map<string, string>();
  private variablesRevision = Number.NaN;

  private readonly host: ScriptDebugObserverHost;

  constructor(host: ScriptDebugObserverHost) {
    this.host = host;
  }

  get observing(): boolean {
    return this.target !== null;
  }

  /** Applies the editor's request; it replaces the previous one. */
  observe(target: DebugObserveTarget | null, instanceId: string | null): void {
    const changed = !sameDebugObserveTarget(target, this.target);
    this.target = target;
    if (changed) {
      this.sent = null;
      this.basis = null;
    }
    if (!target) {
      this.follow(null);
      return;
    }
    this.publishRoster();
    if (instanceId === null) this.follow(null);
    else if (changed || this.followed?.guid !== instanceId || this.followed.destroyed) {
      this.follow(findInstance(this.host.world(), target, instanceId));
      this.publishVariables(this.host.world().clock.tickIndex);
    }
  }

  /** End of a tick: what the followed instance ran, then roster changes. */
  flush(tickIndex: number): void {
    const target = this.target;
    if (!target) return;
    const graphs = this.sink?.drain() ?? [];
    const steps = this.sink?.drainSteps(graphs) ?? null;
    if (this.followed && graphs.length > 0) {
      this.host.emit({
        type: "executionTrace", target, instanceId: this.followed.guid, tickIndex, graphs,
        ...(steps ? { steps: steps.steps, ...(steps.truncated ? { stepsTruncated: true } : {}) } : {}),
      });
    }
    this.publishVariables(tickIndex);
    // Its On Destroyed run was the last thing worth reporting.
    if (this.followed?.destroyed) this.follow(null);
    this.publishRoster();
  }

  /** The session ends: drop the sink and the instance. */
  dispose(): void {
    this.target = null;
    this.follow(null);
  }

  private follow(object: BObject | null): void {
    this.sink?.close();
    this.followed = object;
    this.sink = object ? new ExecutionTraceSink() : null;
    this.variableTexts = new Map();
    this.variablesRevision = Number.NaN;
    this.host.setDebugTrace(object, this.sink);
  }

  /**
   * The followed instance's declared variables whose text changed. Any object's script can set them, so
   * this does not wait for the instance's own graphs to run; an unchanged variables revision skips it.
   */
  private publishVariables(tickIndex: number): void {
    const object = this.followed;
    const target = this.target;
    if (!object || target?.kind !== "class") return;
    const revision = object.variablesRevision;
    if (revision === this.variablesRevision) return;
    this.variablesRevision = revision;
    const values: Array<[string, string]> = [];
    for (const { name } of this.host.world().classRegistry.inheritedVariables(object.classId)) {
      const text = formatDebugValue(object.variables.get(name));
      if (this.variableTexts.get(name) === text) continue;
      this.variableTexts.set(name, text);
      values.push([name, text]);
    }
    if (values.length > 0) this.host.emit({ type: "debugVariables", target, instanceId: object.guid, tickIndex, values });
  }

  private publishRoster(): void {
    const target = this.target;
    if (!target) return;
    const world = this.host.world();
    const previous = this.sent;
    if (target.kind === "class") {
      // A class never changes, so the world's structure decides whether its roster can have changed.
      const subsystems = world.getGameSubsystems().length + world.getSceneSubsystems().length;
      const basis = this.basis;
      if (basis && basis.revision === world.structuralRevision && basis.gameInstance === world.gameInstance &&
        basis.subsystems === subsystems) return;
      this.basis = { revision: world.structuralRevision, gameInstance: world.gameInstance, subsystems };
    } else if (previous && sameComponentRoster(world, target, previous)) {
      // The asset a component runs is a variable a script can set, so a component target is walked each tick
      // (only the actors owning such a component), allocating nothing while the roster holds.
      return;
    }
    const current = debugInstancesOf(world, target);
    const next = new Map(current.map((instance) => [instance.id, instance]));
    this.sent = next;
    if (!previous) {
      this.host.emit({ type: "debugRoster", target, reset: true, added: current, removed: [] });
      return;
    }
    const removed = [...previous.keys()].filter((id) => !next.has(id));
    const added = current.filter((instance) => {
      const before = previous.get(instance.id);
      return !before || before.label !== instance.label || before.ownerLabel !== instance.ownerLabel;
    });
    if (added.length > 0 || removed.length > 0) {
      this.host.emit({ type: "debugRoster", target, reset: false, added, removed });
    }
  }
}
