import type { SerializedGraph } from "@haptic/core";

/** Pin metadata embedded in node data by @haptic/scripting serialize. */
export type SerializedPin = {
  /** Optional compact display hint supplied by a typed graph host. */
  typeLabel?: string;
  /** What the pin does, shown as the pin name's tooltip. */
  description?: string;
  group?: string;
  id: string;
  name: string;
  kind: "exec" | "data";
  /**
   * A `data` pin with a resolving wildcard type that may also bind to exec (a Reroute's pins). Its
   * effective kind is `exec` while its display type is exec, else `data` (`effectivePinKind`).
   */
  anyKind?: boolean;
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
  /** A Pass-By-Reference function input on its Input node: drawn as a reference diamond. */
  byReference?: boolean;
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

export type GraphEdge = SerializedGraph["edges"][number];

export type GraphDocument = SerializedGraph;

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
  /**
   * A CSS colour for the row's chip, matching the node's header (`data.__headerColor`); text and icon
   * switch between black and white for contrast.
   */
  headerColor?: string;
  /** When true, added nodes stamp `data.__editorOnly` for the canvas banner. */
  editorOnly?: boolean;
  /**
   * Not reachable from the host graph on its own (other-class members, engine
   * component APIs, scene-placed components, rows meant for a dragged pin).
   * Context Sensitive hides these rows while no pin is dragged.
   */
  outOfContext?: boolean;
  /**
   * The input taking the object the row acts on (its Target). Unless that pin
   * reads Self while unwired (`selfWhenUnwired`), a dragged pin lists the row
   * under Context Sensitive only when it connects to this pin; rows whose
   * Target the dragged object reaches rank first, its own class's first.
   */
  targetPinId?: string;
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

/** The pin a wire is being dragged from, with its resolved type (a connected Wildcard's). */
export type GraphPinDragSource = {
  nodeId: string;
  pin: SerializedPin;
  type: SerializedPin["type"];
};

/**
 * Lets a node's body take a dragged wire as a new pin of that type (a
 * function's Input and Output nodes). While the wire is over a node that
 * `accepts` it, it shows **+ Add Pin**; released there, `drop` adds the pin
 * and its wire as one graph change. A release on a pin connects as usual.
 */
export type GraphPinDrop = {
  accepts: (targetNodeId: string, source: GraphPinDragSource) => boolean;
  drop: (targetNodeId: string, source: GraphPinDragSource) => void;
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

/**
 * Whether canvas node data is a Reroute knot: a pass-through node with one `in` and one `out` pin,
 * drawn as a small knot. Hosts stamp the editor-only `__reroute: true` key, as they stamp `__pure`.
 */
export function isRerouteNodeData(data: Record<string, unknown> | undefined | null): boolean {
  return data?.__reroute === true;
}
