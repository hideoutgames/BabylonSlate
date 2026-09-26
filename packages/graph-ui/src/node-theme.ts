import {
  PARTICLE_STAGE_ROLE,
  pinColorVar,
  type ParticleStage,
} from "@babylonslate/ui/lib/data-types";

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
  | "variable-set"
  | "latent"
  | "debug"
  | "bt-root"
  | "bt-composite"
  | "bt-task";

const ROLE_CLASS: Record<NodeVisualRole, string> = {
  event: "bg-node-event",
  "call-parent": "bg-node-call-parent",
  function: "bg-node-function",
  pure: "bg-node-pure",
  flow: "bg-node-flow",
  variable: "bg-node-variable",
  "variable-set": "bg-node-variable-set",
  latent: "bg-node-latent",
  debug: "bg-node-debug",
  "bt-root": "bg-node-bt-root",
  "bt-composite": "bg-node-bt-composite",
  "bt-task": "bg-node-bt-task",
};

export type PinVisualShape = "diamond" | "circle" | "list" | "map";

export function pinCssVar(type: PinTypeRef): string {
  if (type.kind === "array" && isPinTypeRef(type.element)) {
    return pinCssVar(type.element);
  }
  if (type.kind === "map" && isPinTypeRef(type.value)) {
    return pinCssVar(type.value);
  }
  return pinColorVar(type.kind);
}

export function pinVisualShape(type: PinTypeRef): PinVisualShape {
  if (type.kind === "exec") return "diamond";
  if (type.kind === "array") return "list";
  if (type.kind === "map") return "map";
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

export function nodeVisualRole(input: {
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
}): NodeVisualRole {
  if (input.particleRole !== undefined && isParticleStage(input.particleRole)) {
    return PARTICLE_STAGE_ROLE[input.particleRole];
  }
  const nodeType = input.nodeType ?? "";
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
  if (
    nodeType === "input.actionEvent" ||
    nodeType === "input.axisEvent" ||
    nodeType === "input.onAnyKeyPressed" ||
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
  if (category === "variables" || nodeType.startsWith("variables.")) {
    const isSet =
      nodeType === "variables.set" ||
      nodeType.startsWith("variables.set:") ||
      /^set\b/i.test(title);
    return isSet ? "variable-set" : "variable";
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

/** Exec wires and the Particle Graph spine use the heavy exec width. */
export function edgeStrokeWidth(kind: string): number {
  return kind === "exec" || kind === "particle" ? 5 : 4;
}

export function edgeStyleForPin(type: PinTypeRef | undefined): {
  stroke: string;
  strokeWidth: number;
} {
  const resolved = type ?? { kind: "wildcard" };
  return {
    stroke: pinCssVar(resolved),
    strokeWidth: edgeStrokeWidth(resolved.kind),
  };
}
