import type { BreakpointEvent, BreakpointLocation } from "@haptic/bridge";
import type { BObject } from "@haptic/object-model";

/**
 * Node breakpoints for the editor's Simulation and Play. A breakpoint-instrumented script looks up its graph's
 * breakpoints once per run (`ctx.breakpoints.graph`) and checks each exec node it reaches against them,
 * for every instance. With no breakpoint set, `ctx.breakpoints` is null and a check is one null check.
 * Behaviour Trees and State Machines look up theirs once per component and tick.
 */

/** Where a breakpoint stopped, and on which object. */
export type BreakpointHit = BreakpointLocation & {
  /** The event or function entry node the run started from. */
  entryNodeId: string;
  instance: BObject | null;
  /** The actor that names a Behaviour Tree or Animation Graph component in the Debug Instance list. */
  owner?: BObject;
  event?: BreakpointEvent;
};

/** The breakpoints of one graph. */
export class GraphBreakpoints {
  private readonly nodes = new Set<string>();
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

  /** A node with a breakpoint ran. */
  hit(
    nodeId: string,
    entryNodeId: string,
    instance: BObject | null,
    detail?: { owner?: BObject; event?: BreakpointEvent },
  ): void {
    this.onHit({ assetGuid: this.assetGuid, graphId: this.graphId, nodeId, entryNodeId, instance, ...detail });
  }

  /** @internal */
  add(nodeId: string): void {
    this.nodes.add(nodeId);
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

  /** Replaces every breakpoint. A run already under way keeps the graph's breakpoints it looked up. */
  set(locations: readonly BreakpointLocation[]): void {
    const graphs = new Map<string, Map<string, GraphBreakpoints>>();
    for (const { assetGuid, graphId, nodeId } of locations) {
      let byGraph = graphs.get(assetGuid);
      if (!byGraph) graphs.set(assetGuid, byGraph = new Map());
      let breakpoints = byGraph.get(graphId);
      if (!breakpoints) byGraph.set(graphId, breakpoints = new GraphBreakpoints(assetGuid, graphId, this.onHit));
      breakpoints.add(nodeId);
    }
    this.graphs = graphs;
  }

  /** The breakpoints of one graph, or null when it has none. */
  graph(assetGuid: string, graphId: string): GraphBreakpoints | null {
    return this.graphs.get(assetGuid)?.get(graphId) ?? null;
  }
}
