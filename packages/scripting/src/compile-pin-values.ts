import { humanizePropertyLabel, normalizeTag, normalizeTagContainer } from "@haptic/core";
import type { GraphNode, GraphPin } from "./ir";
import type { NodeRegistry } from "./node-registry";
import { pinRejectsStoredDefault, readPinDefaultForPin } from "./pin-defaults";
import { defaultValueLiteral } from "./types";

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
 * subject reports and the output reads `fallback`. The inputs are bound to
 * `__s<n>` so each is evaluated once.
 */
export function guardPureExpression(
  subjects: readonly SubjectPin[],
  args: readonly string[],
  expression: string,
  fallback: string,
  location: string,
): string {
  const names = subjects.map((_, index) => `__s${index}`);
  const report = subjects
    .map((subject, index) => {
      const name = names[index];
      const nullLog = `ctx.nullAccess(${JSON.stringify(subject.message)})`;
      const destroyedLog = `ctx.destroyedAccess(${location}, ${name})`;
      return `(${name} == null ? ${nullLog} : ${name}.destroyed === true && ${destroyedLog})`;
    })
    .join(", ");
  const anyDead = names.map((name) => deadReference(name)).join(" || ");
  return `((${names.join(", ")}) => ${anyDead} ? (${report}, ${fallback}) : (${expression}))(${args.join(", ")})`;
}

export function disconnectedPinLiteral(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
  fallbackLiteral?: string,
): string {
  if (catalogFlag(node, dataPin, registry, "selfWhenUnwired")) return "ctx.self";
  const prop = readPinDefaultForPin(node.properties, dataPin);
  if (prop !== undefined && !pinRejectsStoredDefault(dataPin.type)) {
    if (dataPin.type.kind === "tag") return JSON.stringify(normalizeTag(prop));
    if (dataPin.type.kind === "structRef" && dataPin.type.guid === "engine:TagContainer") {
      return JSON.stringify(normalizeTagContainer(prop));
    }
    return JSON.stringify(prop);
  }
  const catalog = catalogPinDefault(node, dataPin, registry);
  if (catalog !== undefined) return JSON.stringify(catalog);
  return fallbackLiteral ?? defaultValueLiteral(dataPin.type);
}
