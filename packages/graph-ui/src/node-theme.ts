import { pinColorVar } from "@babylonslate/ui/lib/data-types";

export type PinTypeRef = {
  kind: string;
  [key: string]: unknown;
};

export type NodeVisualRole =
  | "event"
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

export type PinVisualShape = "diamond" | "circle" | "list";

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

export function nodeVisualRole(input: {
  nodeType?: string;
  title?: string;
  category?: string;
  pure?: boolean;
  latent?: boolean;
}): NodeVisualRole {
  const nodeType = input.nodeType ?? "";
  const title = input.title ?? "";
  const category = (input.category ?? "").toLowerCase();

  if (
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
    return /set/i.test(nodeType) || /set/i.test(title)
      ? "variable-set"
      : "variable";
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

export function edgeStrokeWidth(kind: string): number {
  return kind === "exec" ? 5 : 4;
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
