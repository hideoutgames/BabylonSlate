import { humanizePropertyLabel, normalizeTag, normalizeTagContainer } from "@haptic/core";
import type { GraphNode, GraphPin } from "./ir";
import type { NodeRegistry, UnboxedVector } from "./node-registry";
import { pinRejectsStoredDefault, readPinDefaultForPin } from "./pin-defaults";
import { defaultValueLiteral, type PinType } from "./types";

function catalogPinDefault(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
): unknown {
  if (dataPin.defaultValue !== undefined) return dataPin.defaultValue;
  const def = registry.get(node.typeId);
  if (!def) return undefined;
  const catalogPins = def.pins(node.properties);
  const catalogPin =
    catalogPins.find((pin) => pin.id === dataPin.id) ??
    catalogPins.find((pin) => pin.name === dataPin.name);
  return catalogPin?.defaultValue;
}

/**
 * Object and delegate inputs are the only pins that act as a node's subject;
 * only object inputs read Self.
 */
function isObjectReferenceInput(pin: GraphPin): boolean {
  return pin.direction === "in" && pin.kind === "data" &&
    (pin.type.kind === "objectRef" || pin.type.kind === "delegate");
}

/**
 * The catalog's flag wins over the saved pin's, so a flag added to a node type
 * reaches graphs saved before it.
 */
function catalogFlag(
  node: GraphNode,
  pin: GraphPin,
  registry: NodeRegistry,
  flag: "selfWhenUnwired" | "subject",
): boolean {
  if (!isObjectReferenceInput(pin)) return false;
  const catalog = registry.get(node.typeId)?.pins(node.properties).find((entry) => entry.id === pin.id);
  return (catalog ?? pin)[flag] === true;
}

/** What a node does to its subject, as a destroyed-object diagnostic names it. */
export type SubjectAccess = { kind: "access" | "set" | "call"; member: string };

export type SubjectPin = { pin: GraphPin; message: string };

function propertyText(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * What `node` does to its subject: reads or writes a variable (by its name), or calls a function, interface
 * method or anything else (by the function's name, else the node's title).
 */
export function subjectAccessOf(node: GraphNode, registry: NodeRegistry): SubjectAccess {
  const title = propertyText(node.properties, "title") || registry.get(node.typeId)?.title || node.typeId;
  const variable = propertyText(node.properties, "variableName") || "Value";
  switch (node.typeId) {
    case "variables.get":
    case "variables.getValidated":
      return { kind: "access", member: variable };
    case "variables.set":
    case "variables.setByRef":
      return { kind: "set", member: variable };
    case "functions.call":
      return { kind: "call", member: propertyText(node.properties, "functionName") || title };
    case "flow.event.call":
      return { kind: "call", member: propertyText(node.properties, "name") || title };
    case "interface.call":
      return { kind: "call", member: propertyText(node.properties, "method") || title };
    default:
      return { kind: "call", member: title };
  }
}

/**
 * A node's subject inputs: the objects it reads, writes, calls or moves. The
 * message is logged each time one is null as the node runs; one holding a
 * destroyed object reports a destroyed access at the node's location.
 */
export function subjectPinsOf(
  node: GraphNode,
  registry: NodeRegistry,
  className: string | undefined,
): SubjectPin[] {
  const def = registry.get(node.typeId);
  const references = node.pins.filter(isObjectReferenceInput);
  if (!def || references.length === 0) return [];
  const catalog = def.pins(node.properties);
  const authored = typeof node.properties.title === "string" ? node.properties.title.trim() : "";
  const where = `${className ? `${className}: ` : ""}${authored || def.title}`;
  return references
    .filter((pin) => (catalog.find((entry) => entry.id === pin.id) ?? pin).subject === true)
    .map((pin) => {
      const subject = `${where} (${humanizePropertyLabel(pin.name)})`;
      return {
        pin,
        message: `${subject} tried to access null.`,
      };
    });
}

/**
 * Whether the reference held by `name` (a plain identifier, read once by the
 * caller) is unusable: empty, or an object that has been destroyed.
 */
export function deadReference(name: string): string {
  return `(${name} == null || ${name}.destroyed === true)`;
}

/**
 * The statement that reports why the reference in `name` is unusable, when it is: null logs the subject's
 * message, a destroyed object reports a destroyed access at `location` (a module-scope location constant).
 */
export function reportDeadReference(subject: SubjectPin, name: string, location: string): string {
  return `if (${name} == null) ctx.nullAccess(${JSON.stringify(subject.message)}); else if (${name}.destroyed === true) ctx.destroyedAccess(${location}, ${name});`;
}

/**
 * A pure node's output expression behind its subject guard: a null or destroyed
 * subject reports and the output reads `fallback`. The inputs are bound once
 * into entry-scoped temp locals (`tempNames`) so no closure is allocated per tick.
 */
export function guardPureExpression(
  subjects: readonly SubjectPin[],
  args: readonly string[],
  expression: string,
  fallback: string,
  location: string,
  tempNames?: readonly string[],
): string {
  const names = tempNames ?? subjects.map((_, index) => `__s${index}`);
  const binds = args.map((arg, index) => `${names[index]} = (${arg})`).join(", ");
  const report = subjects
    .map((subject, index) => {
      const name = names[index];
      const nullLog = `ctx.nullAccess(${JSON.stringify(subject.message)})`;
      const destroyedLog = `ctx.destroyedAccess(${location}, ${name})`;
      return `(${name} == null ? ${nullLog} : ${name}.destroyed === true && ${destroyedLog})`;
    })
    .join(", ");
  const anyDead = names.map((name) => deadReference(name)).join(" || ");
  return `(${binds}, ${anyDead} ? (${report}, ${fallback}) : (${expression}))`;
}

const IMMUTABLE_OBJECT_PIN_KINDS = new Set<PinType["kind"]>([
  "vec2", "vec3", "vec4", "rotator", "quat", "color", "transform", "boxedWildcard",
]);

/** Immutable deep-freeze literal text for pooling non-primitive value defaults. */
export function frozenLiteralText(type: PinType, literal: string): string {
  if (type.kind === "transform") {
    try {
      const parsed = JSON.parse(literal) as {
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
      };
      if (parsed && typeof parsed === "object") {
        const pos = parsed.position ?? { x: 0, y: 0, z: 0 };
        const rot = parsed.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
        const scale = parsed.scale ?? { x: 1, y: 1, z: 1 };
        return `{ position: Object.freeze(${JSON.stringify(pos)}), rotation: Object.freeze(${JSON.stringify(rot)}), scale: Object.freeze(${JSON.stringify(scale)}) }`;
      }
    } catch {
      // Fall back to default transform literal.
    }
    return "{ position: Object.freeze({ x: 0, y: 0, z: 0 }), rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }), scale: Object.freeze({ x: 1, y: 1, z: 1 }) }";
  }
  if (type.kind === "structRef" && type.guid === "engine:TagContainer") {
    try {
      const parsed = JSON.parse(literal) as { Tags?: unknown };
      const tags = Array.isArray(parsed?.Tags) ? parsed.Tags : [];
      return `{ Tags: Object.freeze(${JSON.stringify(tags)}) }`;
    } catch {
      return "{ Tags: Object.freeze([]) }";
    }
  }
  return literal;
}

function isObjectOrArrayLiteral(literal: string): boolean {
  const first = literal.trimStart()[0];
  return first === "{" || first === "[";
}

function shouldPoolLiteral(type: PinType, literal: string, allowMutableContainers: boolean): boolean {
  if (!isObjectOrArrayLiteral(literal)) return false;
  if (IMMUTABLE_OBJECT_PIN_KINDS.has(type.kind)) return true;
  if (type.kind === "structRef" && type.guid === "engine:TagContainer") return true;
  if (allowMutableContainers && (type.kind === "array" || type.kind === "structRef")) return true;
  return false;
}

/**
 * Default JS expression for `type`, using a module-top frozen constant or shared empty Map
 * sentinel for non-primitive types so entry preambles allocate nothing per tick.
 */
export function pooledDefaultValueLiteral(
  type: PinType,
  poolConstant: (literal: string) => string,
  emptyMap?: () => string,
  allowMutableContainers = true,
): string {
  if (type.kind === "map" && allowMutableContainers && emptyMap) return emptyMap();
  const literal = defaultValueLiteral(type);
  if (shouldPoolLiteral(type, literal, allowMutableContainers)) {
    return poolConstant(frozenLiteralText(type, literal));
  }
  return literal;
}

export function disconnectedPinLiteral(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
  fallbackLiteral?: string,
  poolConstant?: (literal: string) => string,
  emptyMap?: () => string,
  allowMutableContainers = true,
): string {
  if (catalogFlag(node, dataPin, registry, "selfWhenUnwired")) return "ctx.self";
  const maybePool = (literal: string): string => {
    if (!poolConstant) return literal;
    if (dataPin.type.kind === "map" && allowMutableContainers && emptyMap && literal === "new Map()") {
      return emptyMap();
    }
    if (shouldPoolLiteral(dataPin.type, literal, allowMutableContainers)) {
      return poolConstant(frozenLiteralText(dataPin.type, literal));
    }
    return literal;
  };
  const prop = readPinDefaultForPin(node.properties, dataPin);
  if (prop !== undefined && !pinRejectsStoredDefault(dataPin.type)) {
    if (dataPin.type.kind === "tag") return JSON.stringify(normalizeTag(prop));
    if (dataPin.type.kind === "structRef" && dataPin.type.guid === "engine:TagContainer") {
      return maybePool(JSON.stringify(normalizeTagContainer(prop)));
    }
    return maybePool(JSON.stringify(prop));
  }
  const catalog = catalogPinDefault(node, dataPin, registry);
  if (catalog !== undefined) return maybePool(JSON.stringify(catalog));
  if (fallbackLiteral !== undefined) return fallbackLiteral;
  return poolConstant
    ? pooledDefaultValueLiteral(dataPin.type, poolConstant, emptyMap, allowMutableContainers)
    : defaultValueLiteral(dataPin.type);
}

/**
 * Unboxed numeric component literals for a disconnected `vec2`/`vec3`/`vec4`/`quat`/`color`
 * input pin, or undefined when the pin is not a vector-like kind.
 */
export function disconnectedVectorComponents(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
): UnboxedVector | undefined {
  const kind = dataPin.type.kind;
  if (kind !== "vec2" && kind !== "vec3" && kind !== "vec4" && kind !== "quat" && kind !== "color") {
    return undefined;
  }
  const prop = readPinDefaultForPin(node.properties, dataPin);
  const raw = (prop !== undefined && !pinRejectsStoredDefault(dataPin.type) ? prop : catalogPinDefault(node, dataPin, registry)) as
    | Record<string, unknown>
    | undefined;
  const num = (axis: string, fallback: number): string => {
    const v = raw && typeof raw === "object" ? raw[axis] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? String(v) : String(fallback);
  };
  if (kind === "vec2") return { kind: "vec2", x: num("x", 0), y: num("y", 0) };
  if (kind === "vec3") return { kind: "vec3", x: num("x", 0), y: num("y", 0), z: num("z", 0) };
  return {
    kind,
    x: num("x", 0),
    y: num("y", 0),
    z: num("z", 0),
    w: num("w", kind === "quat" ? 1 : 0),
  };
}
