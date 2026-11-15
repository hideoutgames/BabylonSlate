import { isTouchEventNodeType } from "@haptic/scripting";
import {
  PARTICLE_STAGE_ROLE,
  pinColorVar,
  type ParticleStage,
} from "@haptic/ui/lib/data-types";

export type PinTypeRef = {
  kind: string;
  [key: string]: unknown;
};

export type NodeVisualRole =
  | "event"
  | "call-parent"
  | "function"
  | "pure"
  | "flow"
  | "variable"
  | "latent"
  | "debug"
  | "bt-root"
  | "bt-composite"
  | "bt-task"
  /** Animation Graph pose nodes: players, blends, outputs. */
  | "anim-pose"
  /** Animation Graph skeletal controls acting on a pose (IK, Look At, Spring Bones). */
  | "anim-control";

const ROLE_CLASS: Record<NodeVisualRole, string> = {
  event: "bg-node-event",
  "call-parent": "bg-node-call-parent",
  function: "bg-node-function",
  pure: "bg-node-pure",
  flow: "bg-node-flow",
  variable: "bg-node-variable",
  latent: "bg-node-latent",
  debug: "bg-node-debug",
  "bt-root": "bg-node-bt-root",
  "bt-composite": "bg-node-bt-composite",
  "bt-task": "bg-node-bt-task",
  "anim-pose": "bg-node-anim-pose",
  "anim-control": "bg-node-anim-control",
};

export type PinVisualShape = "diamond" | "reference" | "circle" | "list" | "map" | "square";

export function pinCssVar(type: PinTypeRef): string {
  if (type.kind === "array" && isPinTypeRef(type.element)) {
    return pinCssVar(type.element);
  }
  if (type.kind === "map" && isPinTypeRef(type.value)) {
    return pinCssVar(type.value);
  }
  return pinColorVar(type.kind);
}

/**
 * A by-reference pin (an input that takes a writable variable, or a Pass-By-Reference function input
 * on its Input node) is a small diamond, as in Unreal, whatever its type.
 */
export function pinVisualShape(
  type: PinTypeRef,
  pin?: { reference?: "required" | "writable"; byReference?: boolean },
): PinVisualShape {
  if (type.kind === "exec") return "diamond";
  if (pin?.reference === "required" || pin?.byReference === true) return "reference";
  if (type.kind === "array") return "list";
  if (type.kind === "map") return "map";
  if (type.kind === "delegate") return "square";
  return "circle";
}

function isPinTypeRef(value: unknown): value is PinTypeRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

function isParticleStage(value: string): value is ParticleStage {
  return Object.hasOwn(PARTICLE_STAGE_ROLE, value);
}

export type NodeVisualInput = {
  nodeType?: string;
  title?: string;
  category?: string;
  pure?: boolean;
  latent?: boolean;
  material?: boolean;
  /**
   * Particle Graph stage (`__particleRole`). Headers share the Basic Particle
   * Emitter stage colours; values that are not a stage fall through.
   */
  particleRole?: string;
  /** Behaviour Tree node kind (`selector`, `sequence`, `parallel`, `task`) for `bt.node` rows. */
  btKind?: string;
};

export function nodeVisualRole(input: NodeVisualInput): NodeVisualRole {
  if (input.particleRole !== undefined && isParticleStage(input.particleRole)) {
    return PARTICLE_STAGE_ROLE[input.particleRole];
  }
  const nodeType = input.nodeType ?? "";
  if (nodeType === "bt.node") return input.btKind === "task" ? "bt-task" : "bt-composite";
  // State machine states are cards without a title bar; their Add Node rows take the pose colour.
  if (nodeType === "anim.state" || nodeType === "anim.alias") return "anim-pose";
  const title = input.title ?? "";
  const category = (input.category ?? "").toLowerCase();
  if (input.material) {
    if (nodeType.startsWith("output.")) return "event";
    if (nodeType.startsWith("const.")) return "pure";
    if (nodeType.startsWith("param.") || category === "input") return "variable";
    if (category === "texture") return "latent";
    if (nodeType === "custom.glsl") return "call-parent";
    if (nodeType.startsWith("function.")) return "function";
    return "flow";
  }

  if (nodeType === "flow.event.callParent") {
    return "call-parent";
  }
  // Calling a custom event is a function call; red headers are for events.
  if (nodeType === "flow.event.call") {
    return "function";
  }
  if (nodeType.startsWith("anim.pose.") || nodeType.startsWith("anim.frame.")) return "anim-pose";
  if (nodeType.startsWith("anim.control.")) return "anim-control";
  if (
    nodeType === "input.actionEvent" ||
    nodeType === "input.axisEvent" ||
    nodeType === "input.onAnyKeyPressed" ||
    isTouchEventNodeType(nodeType) ||
    nodeType.startsWith("flow.event") ||
    nodeType.startsWith("anim.event") ||
    nodeType.startsWith("anim.rule") ||
    /^event\b/i.test(title)
  ) {
    return "event";
  }
  if (input.latent || category === "timers") {
    return "latent";
  }
  if (category === "debug") {
    return "debug";
  }
  // Set nodes share the Get colour.
  if (category === "variables" || nodeType.startsWith("variables.")) {
    return "variable";
  }
  if (category === "flow") {
    return "flow";
  }
  if (input.pure) {
    return "pure";
  }
  return "function";
}

export function nodeRoleClass(role: NodeVisualRole): string {
  return ROLE_CLASS[role];
}

/**
 * What a node is, shown as the icon left of its title and on its Add Node row
 * (`node-icons.tsx`). Finer than the header colour: latent calls, input events,
 * Script Interface endpoints and Event Dispatchers have their own kinds.
 */
export type NodeKind =
  | "event"
  | "input-event"
  | "function"
  | "pure"
  | "latent"
  | "interface"
  | "dispatcher"
  | "call-event"
  | "call-parent"
  | "flow"
  | "loop"
  | "variable"
  | "material-output"
  | "operation"
  | "constant"
  | "parameter"
  | "input"
  | "texture"
  | "custom-code"
  | "emitter-output"
  | "create"
  | "shape"
  | "update"
  | "player"
  | "blend"
  | "select"
  | "rest-pose"
  | "flip"
  | "skeletal-control"
  | "output-pose"
  | "output-frame"
  | "state"
  | "state-alias"
  | "bt-selector"
  | "bt-sequence"
  | "bt-parallel"
  | "bt-task";

export type NodeKindInput = NodeVisualInput & {
  /** A function graph's Input or Output node in a Script Interface implementation (`__interface`). */
  interface?: boolean;
};

const INPUT_EVENT_TYPE_IDS: ReadonlySet<string> = new Set([
  "input.actionEvent",
  "input.axisEvent",
  "input.onAnyKeyPressed",
  "input.onGamepadConnected",
  "input.onGamepadDisconnected",
]);

const PARTICLE_STAGE_KIND: Record<ParticleStage, NodeKind> = {
  output: "emitter-output",
  create: "create",
  shape: "shape",
  update: "update",
  input: "parameter",
  value: "operation",
};

const BT_KIND: Record<string, NodeKind> = {
  selector: "bt-selector",
  sequence: "bt-sequence",
  parallel: "bt-parallel",
  task: "bt-task",
};

function materialNodeKind(nodeType: string, category: string): NodeKind {
  if (nodeType.startsWith("output.")) return "material-output";
  if (nodeType.startsWith("const.")) return "constant";
  if (nodeType.startsWith("param.") || nodeType === "global.parameter") return "parameter";
  if (category === "input") return "input";
  if (category === "texture") return "texture";
  if (nodeType === "custom.glsl") return "custom-code";
  if (nodeType.startsWith("function.")) return "function";
  return "operation";
}

function animNodeKind(nodeType: string): NodeKind | null {
  switch (nodeType) {
    case "anim.state":
      return "state";
    case "anim.alias":
      return "state-alias";
    case "anim.pose.output":
      return "output-pose";
    case "anim.frame.output":
      return "output-frame";
    case "anim.pose.restPose":
      return "rest-pose";
    case "anim.frame.flip":
      return "flip";
  }
  if (nodeType.startsWith("anim.control.")) return "skeletal-control";
  if (!nodeType.startsWith("anim.pose.") && !nodeType.startsWith("anim.frame.")) return null;
  if (/(?:Player|Evaluator)$/.test(nodeType)) return "player";
  if (nodeType.startsWith("anim.frame.select")) return "select";
  if (nodeType.startsWith("anim.pose.blend")) return "blend";
  return null;
}

export function nodeKind(input: NodeKindInput): NodeKind {
  const nodeType = input.nodeType ?? "";
  if (input.particleRole !== undefined && isParticleStage(input.particleRole)) {
    return PARTICLE_STAGE_KIND[input.particleRole];
  }
  if (input.material) return materialNodeKind(nodeType, (input.category ?? "").toLowerCase());
  if (nodeType === "bt.node") return BT_KIND[input.btKind ?? ""] ?? "bt-task";
  const anim = animNodeKind(nodeType);
  if (anim) return anim;
  if (nodeType === "interface.call" || input.interface === true) return "interface";
  if (nodeType.startsWith("flow.dispatcher.") || nodeType === "flow.delegate.create") return "dispatcher";
  if (nodeType === "flow.event.call") return "call-event";
  if (nodeType === "flow.event.callParent") return "call-parent";
  if (INPUT_EVENT_TYPE_IDS.has(nodeType) || isTouchEventNodeType(nodeType)) return "input-event";
  if (nodeType === "flow.function.input" || nodeType === "flow.function.output") return "function";
  switch (nodeVisualRole(input)) {
    case "event":
      return "event";
    case "latent":
      return "latent";
    case "variable":
      return "variable";
    case "flow":
      return /^flow\.(?:forEach|forLoop|whileLoop)/.test(nodeType) ? "loop" : "flow";
    case "pure":
      return "pure";
    default:
      return "function";
  }
}

/**
 * Exec wires and the Particle Graph spine use the heavy exec width. Both
 * widths scale with Large Pins (`--graph-wire-*` in graph-editor.css).
 */
function edgeStrokeWidth(kind: string): string {
  return kind === "exec" || kind === "particle" || kind === "pose" || kind === "frame"
    ? "var(--graph-wire-exec, 5px)"
    : "var(--graph-wire-data, 4px)";
}

const PIN_TYPE_LETTER: Record<string, string> = {
  bool: "B",
  int: "I",
  float: "F",
  string: "S",
  tag: "Tg",
  vec2: "V2",
  vec3: "V3",
  vec4: "V4",
  rotator: "R",
  quat: "Q",
  transform: "T",
  color: "C",
  objectRef: "O",
  classRef: "Cl",
  assetRef: "A",
  texture: "Tx",
  structRef: "St",
  enumRef: "E",
  resolvingWildcard: "?",
  boxedWildcard: "?",
  delegate: "D",
  particle: "P",
};

/**
 * Pin Type Letters: the short type name drawn inside a data pin (B for
 * Boolean), so types do not rely on colour alone. Arrays and maps show their
 * element type; exec pins have none.
 */
export function pinTypeLetter(type: PinTypeRef): string | undefined {
  if (type.kind === "array" && isPinTypeRef(type.element)) return pinTypeLetter(type.element);
  if (type.kind === "map" && isPinTypeRef(type.value)) return pinTypeLetter(type.value);
  return PIN_TYPE_LETTER[type.kind];
}

export function edgeStyleForPin(type: PinTypeRef | undefined): {
  stroke: string;
  strokeWidth: string;
} {
  const resolved = type ?? { kind: "wildcard" };
  return {
    stroke: pinCssVar(resolved),
    strokeWidth: edgeStrokeWidth(resolved.kind),
  };
}
