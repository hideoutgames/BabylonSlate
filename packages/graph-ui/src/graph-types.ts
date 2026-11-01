import type { SerializedGraph } from "@haptic/core";

/** Pin metadata embedded in node data by @haptic/scripting serialize. */
export type SerializedPin = {
  /** Optional compact display hint supplied by a typed graph host. */
  typeLabel?: string;
  group?: string;
  id: string;
  name: string;
  kind: "exec" | "data";
  direction: "in" | "out";
  type: { kind: string; [key: string]: unknown };
  optional?: boolean;
  defaultValue?: unknown;
  /** Host-supplied numeric literal limits, shared by Inspector and inline edits. */
  min?: number;
  max?: number;
  /** Display unit shown after a number or vector literal (`VALUE_UNITS`). */
  unit?: string;
  reference?: "required" | "writable";
  /** An unwired reference input reads the actor running the graph and shows Self. */
  selfWhenUnwired?: boolean;
  colorHint?: boolean;
  /**
   * The pin keeps one link: a new connection replaces its old one instead of
   * fanning out. Outputs fan out by default (Particle Graph spine outputs opt in).
   */
  singleLink?: boolean;
  /** Drawn at the right end of the title bar instead of in a pin row (a custom event's Output Delegate). */
  placement?: "header";
};

/** Serialized graph with optional pin handles on edges (backward compatible with core). */
export type GraphEdge = SerializedGraph["edges"][number] & {
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
};

export type GraphDocument = Omit<SerializedGraph, "edges"> & {
  edges: GraphEdge[];
};

export type GraphDiagnostic = {
  nodeId?: string;
  pinId?: string;
  severity: string;
  message: string;
};

export type PaletteNode = {
  id: string;
  title: string;
  /**
   * The added node's title when the row names an action instead of the node
   * (`Add Custom Event for On Damaged` adds `Event On Damaged`); else `title`.
   */
  nodeTitle?: string;
  category: string;
  description?: string;
  /** Additional names, operators and formulas accepted by Add Node search. */
  searchAliases?: readonly string[];
  /** Pin defs from the host registry so Add node creates connectable handles. */
  pins?: SerializedPin[];
  /** Default property bag (message, severity, …) merged into node data. */
  defaultData?: Record<string, unknown>;
  /** React Flow node type when `id` is a catalog class id (behaviour trees). */
  nodeType?: string;
  pure?: boolean;
  latent?: boolean;
  /** When true, added nodes stamp `data.__editorOnly` for the canvas banner. */
  editorOnly?: boolean;
  /**
   * Needs a Target on another object (other-class members, engine component
   * APIs, scene-placed components). Context Sensitive hides these rows unless
   * a dragged pin makes them compatible.
   */
  outOfContext?: boolean;
  /**
   * More nodes added together with this one and wired to it (Assign: a Bind
   * node and the custom event bound by it). A dragged pin connects to this
   * node only.
   */
  bundle?: PaletteBundle;
};

export type PaletteBundle = {
  /** Placed at the new node's position plus `offset`, unselected. */
  nodes: ReadonlyArray<{ key: string; node: PaletteNode; offset: { x: number; y: number } }>;
  /** Wires between them; `"main"` names the node the row adds, any other end a `nodes` key. */
  edges: ReadonlyArray<{ source: string; sourceHandle: string; target: string; targetHandle: string }>;
};

export type NavigateRequest = {
  nodeId?: string;
  pinId?: string;
};

export function hasSerializedPins(
  data: Record<string, unknown> | undefined,
): data is Record<string, unknown> & { __pins: SerializedPin[] } {
  return Array.isArray(data?.__pins);
}
