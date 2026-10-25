import type { TagRegistry } from "@haptic/core";
import type { NodeRegistry } from "./node-registry";

export type CompileAnchor = {
  line: number;
  column: number;
  assetGuid: string;
  graphId: string;
  nodeId: string;
  bodyLine?: number;
};

/** Lifecycle events an entry node can bind to at runtime. */
export type ScriptEventName =
  "onBeginPlay" | "onTick" | "onCommandRun" | string;

export type CompiledEntryPoint = {
  /** Exported function name. */
  name: string;
  /** Lifecycle event when the entry node is an event node. */
  event?: ScriptEventName;
  /** Entry node id, for diagnostics. */
  nodeId?: string;
  /** The graph the entry node is in, for diagnostics that open it. */
  graphId?: string;
  /** True when the entry point awaits a latent node and must be awaited. */
  isAsync: boolean;
  /** Prefab component id when this entry is bound to an attached component. */
  componentId?: string;
};

export type CompileResult = {
  source: string;
  anchors: CompileAnchor[];
  /** Name of the first exported entry point. */
  exportName: string;
  /** True when any entry point is async. */
  isAsync: boolean;
  entryPoints: CompiledEntryPoint[];
};

export type CompileOptions = {
  assetGuid: string;
  registry: NodeRegistry;
  /**
   * Display name of the class whose graph this is. Null-access errors name it:
   * "Hero: Destroy Actor (Target) tried to access null."
   */
  className?: string;
  /** Project definitions are embedded so numeric Tag matching survives export. */
  tagRegistry?: TagRegistry;
  exportName?: string;
  /**
   * Export compiles omit Development Only nodes (Print defaults on) and
   * continue exec at `then` / Sequence `then_*`. Editor Play leaves this unset.
   */
  stripDevelopmentOnly?: boolean;
  /**
   * Editor / debugger compiles insert `ctx.checkInfiniteLoop()` so Play can
   * abort runaway scripts. Release export leaves this unset.
   */
  instrumentInfiniteLoops?: boolean;
  /**
   * Editor Simulation compiles report what runs for the instance the editor
   * observes (`ctx.debugTrace`): each exec node visit, the exec edge taken, and
   * the values nodes read and produce. An unobserved instance pays one null
   * check per probe. Ignored when `stripDevelopmentOnly` is set, so release
   * exports never carry it.
   */
  instrumentExecutionTrace?: boolean;
  /**
   * Editor Simulation compiles check each exec node against the session's
   * breakpoints (`ctx.breakpoints`), for every instance. With no breakpoint in
   * the graph a check is one null check. Ignored when `stripDevelopmentOnly`
   * is set, so release exports never carry it.
   */
  instrumentBreakpoints?: boolean;
  /** Function-local `let` lines inserted at the start of each export. */
  localPreamble?: string[];
  /**
   * Call Function awaits `invokeFunction` when this returns true for the
   * target class + export name.
   */
  isLatentFunction?: (classId: string, functionName: string) => boolean;
};
