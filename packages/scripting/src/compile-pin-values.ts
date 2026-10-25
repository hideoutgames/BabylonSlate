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

/** Object reference inputs are the only pins that read Self or act as a node's subject. */
function isObjectReferenceInput(pin: GraphPin): boolean {
  return pin.direction === "in" && pin.kind === "data" && pin.type.kind === "objectRef";
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

export type SubjectPin = { pin: GraphPin; message: string };

/**
 * A node's subject inputs: the objects it reads, writes, calls or moves. The
 * message is logged each time one is null as the node runs.
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
    .map((pin) => ({
      pin,
      message: `${where} (${humanizePropertyLabel(pin.name)}) tried to access null.`,
    }));
}

/**
 * A pure node's output expression behind its subject guard: a null subject logs
 * and the output reads `fallback`. The inputs are bound to `__s<n>` so each is
 * evaluated once.
 */
export function guardPureExpression(
  subjects: readonly SubjectPin[],
  args: readonly string[],
  expression: string,
  fallback: string,
): string {
  const names = subjects.map((_, index) => `__s${index}`);
  const report = subjects
    .map((subject, index) => {
      const log = `ctx.nullAccess(${JSON.stringify(subject.message)})`;
      return subjects.length === 1 ? log : `${names[index]} == null && ${log}`;
    })
    .join(", ");
  const anyNull = names.map((name) => `${name} == null`).join(" || ");
  return `((${names.join(", ")}) => ${anyNull} ? (${report}, ${fallback}) : (${expression}))(${args.join(", ")})`;
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
