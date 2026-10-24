import type { Breakpoint, BreakpointCondition, BreakpointEvent, BreakpointLocation } from "@haptic/bridge";
import type { EngineObject } from "@haptic/object-model";

/**
 * Node breakpoints for the editor's Simulation and Play. A breakpoint-instrumented script looks up its graph's
 * breakpoints once per run (`ctx.breakpoints.graph`) and checks each exec node it reaches against them,
 * for every instance. With no breakpoint set, `ctx.breakpoints` is null and a check is one null check.
 * In a graph with breakpoints, the values nodes read through wires and produce pass through `read` and
 * `write`, where a node's condition is checked. Behaviour Trees and State Machines look up theirs once per
 * component and tick; they have no conditions.
 */

/** Where a breakpoint stopped, and on which object. */
export type BreakpointHit = BreakpointLocation & {
  /** The event or function entry node the run started from. */
  entryNodeId: string;
  instance: EngineObject | null;
  /** The actor that names a Behaviour Tree or Animation Graph component in the Debug Instance list. */
  owner?: EngineObject;
  event?: BreakpointEvent;
};

type HitDetail = { owner?: EngineObject; event?: BreakpointEvent };

/** A node's breakpoint and what it has counted this session. */
export type NodeBreakpoint = {
  condition: BreakpointCondition | null;
  hitCount: number | null;
  /** The settings as one string: sending the same breakpoint again keeps its count. */
  settings: string;
  /** Runs counted: those that met the condition, or every run without one. */
  hits: number;
  /** With a condition, the latest run of the node: it counts once, the first time the value meets it. */
  run: { entryNodeId: string; instance: EngineObject | null; counted: boolean } | null;
};

function settingsOf({ condition, hitCount }: Breakpoint): string {
  return JSON.stringify([condition ?? null, hitCount ?? null]);
}

/** Equality as the condition means it: text compares with a number or boolean a text pin was wired from, as its text. */
function equals(value: unknown, operand: BreakpointCondition["value"]): boolean {
  if (typeof operand === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value) === operand;
  return value === operand;
}

/** Whether `value`, as the script holds it, meets the condition. Order compares numbers only. */
export function meetsBreakpointCondition({ op, value: operand }: BreakpointCondition, value: unknown): boolean {
  switch (op) {
    case "isValid": return value != null;
    case "isNotValid": return value == null;
    case "==": return equals(value, operand);
    case "!=": return !equals(value, operand);
    default: {
      if (typeof value !== "number" || typeof operand !== "number") return false;
      if (op === "<") return value < operand;
      if (op === "<=") return value <= operand;
      if (op === ">") return value > operand;
      return value >= operand;
    }
  }
}

/** The breakpoints of one graph. */
export class GraphBreakpoints {
  private readonly nodes = new Map<string, NodeBreakpoint>();
  private readonly assetGuid: string;
  private readonly graphId: string;
  private readonly onHit: (hit: BreakpointHit) => void;

  constructor(assetGuid: string, graphId: string, onHit: (hit: BreakpointHit) => void) {
    this.assetGuid = assetGuid;
    this.graphId = graphId;
    this.onHit = onHit;
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /**
   * A node with a breakpoint ran. Without a condition the run counts now; with one it counts when the
   * node reads or produces a value that meets it.
   */
  hit(nodeId: string, entryNodeId: string, instance: EngineObject | null, detail?: HitDetail): void {
    const breakpoint = this.nodes.get(nodeId);
    if (!breakpoint) return;
    if (breakpoint.condition) breakpoint.run = { entryNodeId, instance, counted: false };
    else this.count(nodeId, breakpoint, entryNodeId, instance, detail);
  }

  /** A node read `value` from a wired data input; returns it unchanged. */
  read<T>(nodeId: string, pinId: string, value: T): T {
    this.check(nodeId, pinId, "in", value);
    return value;
  }

  /** A node produced `value` on a data output. */
  write(nodeId: string, pinId: string, value: unknown): void {
    this.check(nodeId, pinId, "out", value);
  }

  /** @internal */
  add(breakpoint: Breakpoint, previous: NodeBreakpoint | undefined): void {
    const settings = settingsOf(breakpoint);
    this.nodes.set(breakpoint.nodeId, {
      condition: breakpoint.condition ?? null,
      hitCount: breakpoint.hitCount ?? null,
      settings,
      hits: previous?.settings === settings ? previous.hits : 0,
      run: null,
    });
  }

  /** @internal */
  node(nodeId: string): NodeBreakpoint | undefined {
    return this.nodes.get(nodeId);
  }

  private check(nodeId: string, pinId: string, direction: "in" | "out", value: unknown): void {
    const breakpoint = this.nodes.get(nodeId);
    const run = breakpoint?.run;
    if (!run || run.counted) return;
    const condition = breakpoint.condition!;
    if (condition.pinId !== pinId || condition.direction !== direction || !meetsBreakpointCondition(condition, value)) return;
    run.counted = true;
    this.count(nodeId, breakpoint, run.entryNodeId, run.instance);
  }

  private count(nodeId: string, breakpoint: NodeBreakpoint, entryNodeId: string, instance: EngineObject | null, detail?: HitDetail): void {
    breakpoint.hits++;
    if (breakpoint.hitCount !== null && breakpoint.hits !== breakpoint.hitCount) return;
    this.onHit({ assetGuid: this.assetGuid, graphId: this.graphId, nodeId, entryNodeId, instance, ...detail });
  }
}

/** `ctx.breakpoints`: the session's breakpoints, by asset and graph. */
export class ScriptBreakpoints {
  private graphs = new Map<string, Map<string, GraphBreakpoints>>();
  private readonly onHit: (hit: BreakpointHit) => void;

  constructor(onHit: (hit: BreakpointHit) => void) {
    this.onHit = onHit;
  }

  get empty(): boolean {
    return this.graphs.size === 0;
  }

  /**
   * Replaces every breakpoint. One sent again unchanged keeps its count. A run already under way keeps the
   * graph's breakpoints it looked up.
   */
  set(breakpoints: readonly Breakpoint[]): void {
    const graphs = new Map<string, Map<string, GraphBreakpoints>>();
    for (const breakpoint of breakpoints) {
      const { assetGuid, graphId, nodeId } = breakpoint;
      let byGraph = graphs.get(assetGuid);
      if (!byGraph) graphs.set(assetGuid, byGraph = new Map());
      let graph = byGraph.get(graphId);
      if (!graph) byGraph.set(graphId, graph = new GraphBreakpoints(assetGuid, graphId, this.onHit));
      graph.add(breakpoint, this.graph(assetGuid, graphId)?.node(nodeId));
    }
    this.graphs = graphs;
  }

  /** The breakpoints of one graph, or null when it has none. */
  graph(assetGuid: string, graphId: string): GraphBreakpoints | null {
    return this.graphs.get(assetGuid)?.get(graphId) ?? null;
  }
}
