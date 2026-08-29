/** Pin type system (engineplan §6). */

export type PrimitivePinType =
  | { kind: "exec" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "vec2" }
  | { kind: "vec3" }
  | { kind: "vec4" }
  | { kind: "rotator" }
  | { kind: "quat" }
  | { kind: "transform" }
  | { kind: "color" }
  | { kind: "resolvingWildcard"; group?: string }
  | { kind: "boxedWildcard" };

export type PinType =
  | PrimitivePinType
  | { kind: "objectRef"; classId: string }
  | { kind: "actorRef"; classId: string }
  | { kind: "classRef"; classId: string }
  | { kind: "assetRef"; assetType: string }
  | { kind: "structRef"; guid: string }
  | { kind: "enumRef"; guid: string }
  | { kind: "array"; element: PinType }
  | { kind: "map"; key: PinType; value: PinType }
  | {
      kind: "delegate";
      inputs: PinType[];
      outputs: PinType[];
    };

export const EXEC: PinType = { kind: "exec" };
export const BOOL: PinType = { kind: "bool" };
export const INT: PinType = { kind: "int" };
export const FLOAT: PinType = { kind: "float" };
export const STRING: PinType = { kind: "string" };
export const VEC2: PinType = { kind: "vec2" };
export const VEC3: PinType = { kind: "vec3" };
export const VEC4: PinType = { kind: "vec4" };
export const ROTATOR: PinType = { kind: "rotator" };
export const QUAT: PinType = { kind: "quat" };
export const TRANSFORM: PinType = { kind: "transform" };
export const COLOR: PinType = { kind: "color" };
export const RESOLVING_WILDCARD: PinType = { kind: "resolvingWildcard" };
export const BOXED_WILDCARD: PinType = { kind: "boxedWildcard" };

export function objectRef(classId: string): PinType {
  return { kind: "objectRef", classId };
}

export function actorRef(classId: string): PinType {
  return { kind: "actorRef", classId };
}

/** Class value constrained to subclasses of `classId` — not a live instance. */
export function classRef(classId: string): PinType {
  return { kind: "classRef", classId };
}

/** Asset guid constrained to one Content Browser type (`Audio`, `AudioChannel`, …). */
export function assetRef(assetType: string): PinType {
  return { kind: "assetRef", assetType };
}

export function structRef(guid: string): PinType {
  return { kind: "structRef", guid };
}

export function enumRef(guid: string): PinType {
  return { kind: "enumRef", guid };
}

export function arrayOf(element: PinType): PinType {
  return { kind: "array", element };
}

export function mapOf(key: PinType, value: PinType): PinType {
  return { kind: "map", key, value };
}

export function pinTypeEquals(a: PinType, b: PinType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "objectRef":
    case "actorRef":
    case "classRef":
      return a.classId === (b as typeof a).classId;
    case "assetRef":
      return a.assetType === (b as typeof a).assetType;
    case "structRef":
    case "enumRef":
      return a.guid === (b as typeof a).guid;
    case "array":
      return pinTypeEquals(a.element, (b as typeof a).element);
    case "map":
      return (
        pinTypeEquals(a.key, (b as typeof a).key) &&
        pinTypeEquals(a.value, (b as typeof a).value)
      );
    case "delegate": {
      const other = b as typeof a;
      return (
        a.inputs.length === other.inputs.length &&
        a.outputs.length === other.outputs.length &&
        a.inputs.every((t, i) => pinTypeEquals(t, other.inputs[i]!)) &&
        a.outputs.every((t, i) => pinTypeEquals(t, other.outputs[i]!))
      );
    }
    case "resolvingWildcard":
      return (a.group ?? "T") === ((b as typeof a).group ?? "T");
    default:
      return true;
  }
}

export type ClassHierarchy = {
  /** Returns true if `child` is `parent` or inherits from it. */
  isSubclassOf(childClassId: string, parentClassId: string): boolean;
};

export type AssignabilityOptions = {
  hierarchy?: ClassHierarchy;
};

/**
 * Can a value of `from` be wired into a pin of type `to`?
 */
export function isAssignable(
  from: PinType,
  to: PinType,
  options: AssignabilityOptions = {},
): boolean {
  if (from.kind === "exec" || to.kind === "exec") {
    return from.kind === "exec" && to.kind === "exec";
  }
  if (to.kind === "boxedWildcard") return from.kind !== "resolvingWildcard";
  if (from.kind === "resolvingWildcard" || to.kind === "resolvingWildcard") {
    // Resolution happens separately; treat as tentatively compatible.
    return true;
  }
  if (from.kind === "boxedWildcard") return false; // no implicit unbox
  if (from.kind === "int" && to.kind === "float") return true;
  if (pinTypeEquals(from, to)) return true;

  if (from.kind === "classRef" && to.kind === "classRef") {
    if (from.classId === to.classId) return true;
    return options.hierarchy?.isSubclassOf(from.classId, to.classId) ?? false;
  }

  if (from.kind === "assetRef" && to.kind === "assetRef") {
    return (
      from.assetType.trim() === "" ||
      to.assetType.trim() === "" ||
      from.assetType === to.assetType
    );
  }

  if (
    (from.kind === "objectRef" || from.kind === "actorRef") &&
    (to.kind === "objectRef" || to.kind === "actorRef")
  ) {
    if (from.kind === "objectRef" && to.kind === "actorRef") return false;
    if (
      to.kind === "objectRef" &&
      (to.classId === "BObject" || to.classId.trim() === "")
    ) {
      return true;
    }
    if (from.classId === to.classId) return true;
    return options.hierarchy?.isSubclassOf(from.classId, to.classId) ?? false;
  }

  if (from.kind === "array" && to.kind === "array") {
    return isAssignable(from.element, to.element, options);
  }
  if (from.kind === "map" && to.kind === "map") {
    return (
      isAssignable(from.key, to.key, options) &&
      isAssignable(from.value, to.value, options)
    );
  }
  if (from.kind === "delegate" && to.kind === "delegate") {
    if (
      from.inputs.length !== to.inputs.length ||
      from.outputs.length !== to.outputs.length
    ) {
      return false;
    }
    // Contra/covariance: source inputs must accept destination inputs.
    return (
      to.inputs.every((t, i) => isAssignable(t, from.inputs[i]!, options)) &&
      from.outputs.every((t, i) => isAssignable(t, to.outputs[i]!, options))
    );
  }
  return false;
}

/** Default JS literal for a pin type (ExecuteJavaScript output init). */
export function defaultValueLiteral(type: PinType): string {
  switch (type.kind) {
    case "bool":
      return "false";
    case "int":
    case "float":
      return "0";
    case "string":
      return '""';
    case "vec2":
      return "{ x: 0, y: 0 }";
    case "vec3":
      return "{ x: 0, y: 0, z: 0 }";
    case "vec4":
    case "color":
      return "{ x: 0, y: 0, z: 0, w: 0 }";
    case "rotator":
      return "{ pitch: 0, yaw: 0, roll: 0 }";
    case "quat":
      return "{ x: 0, y: 0, z: 0, w: 1 }";
    case "transform":
      return "{ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }";
    case "array":
      return "[]";
    case "map":
      return "new Map()";
    case "boxedWildcard":
      return '{ tag: "null", value: null }';
    case "objectRef":
    case "actorRef":
    case "delegate":
    case "exec":
    case "resolvingWildcard":
      return "null";
    case "structRef":
      return "{}";
    case "enumRef":
      return '""';
    case "classRef":
      return JSON.stringify(type.classId);
    case "assetRef":
      return '""';
  }
}

export function pinTypeTag(type: PinType): string {
  switch (type.kind) {
    case "objectRef":
      return `objectRef:${type.classId}`;
    case "actorRef":
      return `actorRef:${type.classId}`;
    case "classRef":
      return `classRef:${type.classId}`;
    case "assetRef":
      return `assetRef:${type.assetType}`;
    case "structRef":
      return `structRef:${type.guid}`;
    case "enumRef":
      return `enumRef:${type.guid}`;
    case "array":
      return `array<${pinTypeTag(type.element)}>`;
    case "map":
      return `map<${pinTypeTag(type.key)},${pinTypeTag(type.value)}>`;
    case "delegate":
      return "delegate";
    default:
      return type.kind;
  }
}

/** Concrete types that need WildcardTo* converters (string is special-cased). */
export const CONCRETE_WILDCARD_TARGETS: readonly PinType[] = [
  BOOL,
  INT,
  FLOAT,
  VEC2,
  VEC3,
  VEC4,
  ROTATOR,
  QUAT,
  TRANSFORM,
  COLOR,
  objectRef("BObject"),
  actorRef("Actor"),
];
