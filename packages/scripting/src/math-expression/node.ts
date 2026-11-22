import type { GraphPin } from "../ir";
import { pin } from "../node-registry";
import { pinDefaultPropertyKey } from "../pin-defaults";
import { FLOAT, INT, VEC2, VEC3, VEC4, type PinType } from "../types";
import {
  analyzeMathExpression,
  isMathType,
  type MathAnalysis,
  type MathType,
} from "./analyze";
import { parseMathExpression, type MathExpressionError } from "./parse";

/** The Math Expression node's catalog id. */
export const MATH_EXPRESSION_NODE_ID = "math.expression";

/**
 * The node's properties:
 * - `formula`: the text the author typed.
 * - `pinFormula`: while `formula` does not parse, the last formula that did; its pins stay, so
 *   wires survive a typing error. Absent otherwise.
 * - `inputTypes`: an input's type chosen in the Inspector, by variable name; it wins over wires.
 * - `wiredInputTypes`: the type the last wire into an input brought, by variable name; it stays
 *   after the wire is removed, as a numeric operator's operand type does.
 */
export type MathExpressionProperties = {
  formula?: string;
  pinFormula?: string;
  inputTypes?: Record<string, MathType>;
  wiredInputTypes?: Record<string, MathType>;
};

export const mathExpressionInputPinId = (name: string) => `in_${name}`;
export const mathExpressionOutputPinId = (name: string) => `out_${name}`;

const PIN_TYPES: Readonly<Record<MathType, PinType>> = { float: FLOAT, vec2: VEC2, vec3: VEC3, vec4: VEC4 };
/** What a wire into an input whose type follows its wire may carry. */
const WIRE_ACCEPTS: readonly PinType[] = Object.freeze([INT, FLOAT, VEC2, VEC3, VEC4]);

export function mathTypePinType(type: MathType): PinType {
  return PIN_TYPES[type];
}

/** The formula type a wire of `type` gives an input: Integer widens to Float; other types give none. */
export function mathTypeOfPinType(type: { kind: string } | undefined): MathType | undefined {
  if (!type) return undefined;
  if (type.kind === "int") return "float";
  return isMathType(type.kind) ? type.kind : undefined;
}

function typeRecord(value: unknown): Record<string, MathType> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, MathType> = {};
  for (const [name, type] of Object.entries(value)) if (isMathType(type)) out[name] = type;
  return out;
}

export function mathExpressionFormula(properties: Record<string, unknown>): string {
  return typeof properties.formula === "string" ? properties.formula : "";
}

/** The Inspector's type for input `name`, if one is chosen. */
export function mathExpressionExplicitInputType(properties: Record<string, unknown>, name: string): MathType | undefined {
  const types = typeRecord(properties.inputTypes);
  return Object.hasOwn(types, name) ? types[name] : undefined;
}

/** The type input `name` has: the Inspector's, else its wire's, else Float. */
export function mathExpressionInputType(properties: Record<string, unknown>, name: string): MathType {
  const explicit = mathExpressionExplicitInputType(properties, name);
  if (explicit) return explicit;
  const wired = typeRecord(properties.wiredInputTypes);
  return Object.hasOwn(wired, name) ? wired[name]! : "float";
}

/** The node's formula analysed with its input types, and the analysis its pins come from. */
export type MathExpressionNodeState = {
  /** The formula's own analysis; undefined when it does not parse or names a variable wrongly. */
  analysis?: MathAnalysis;
  /** The first error: the parse or name error, else the type error. */
  error?: MathExpressionError;
  /** The analysis the pins follow: the formula's, else the last formula that parsed. */
  pins?: MathAnalysis;
};

export function mathExpressionNodeState(properties: Record<string, unknown>): MathExpressionNodeState {
  const typed = (formula: string) => analyzeMathExpression(formula, (name) => mathExpressionInputType(properties, name));
  const result = typed(mathExpressionFormula(properties));
  if (result.ok) {
    return {
      analysis: result.analysis,
      pins: result.analysis,
      ...(result.analysis.typeError ? { error: result.analysis.typeError } : {}),
    };
  }
  const fallback = typeof properties.pinFormula === "string" ? typed(properties.pinFormula) : undefined;
  return { error: result.error, ...(fallback?.ok ? { pins: fallback.analysis } : {}) };
}

/** The node's pins: inputs in order of first use on the left, outputs in order of assignment on the right. */
export function mathExpressionPins(properties: Record<string, unknown>): GraphPin[] {
  const analysis = mathExpressionNodeState(properties).pins;
  if (!analysis) return [];
  const { inputs, outputs } = analysis.signature;
  return [
    ...inputs.map((input, index) => {
      const graphPin = pin(mathExpressionInputPinId(input.name), input.name, "in", PIN_TYPES[analysis.inputTypes[index]!]);
      return mathExpressionExplicitInputType(properties, input.name) ? graphPin : { ...graphPin, accepts: WIRE_ACCEPTS as PinType[] };
    }),
    ...outputs.map((output, index) => pin(mathExpressionOutputPinId(output.name), output.name, "out", PIN_TYPES[analysis.outputTypes[index]!])),
  ];
}

/** Pin id renames a formula edit makes, old id to new id. */
export type MathExpressionPinRenames = ReadonlyMap<string, string>;

function renameKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!Object.hasOwn(record, from)) return record;
  const next = { ...record };
  next[to] = next[from]!;
  delete next[from];
  return next;
}

/** `properties` with input `from`'s type choices and stored default moved to `to`. */
function renameInput(properties: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const next = { ...properties };
  const explicit = typeRecord(properties.inputTypes);
  const wired = typeRecord(properties.wiredInputTypes);
  if (Object.hasOwn(explicit, from)) next.inputTypes = renameKey(explicit, from, to);
  if (Object.hasOwn(wired, from)) next.wiredInputTypes = renameKey(wired, from, to);
  const fromKey = pinDefaultPropertyKey(mathExpressionInputPinId(from));
  if (Object.hasOwn(properties, fromKey)) {
    next[pinDefaultPropertyKey(mathExpressionInputPinId(to))] = properties[fromKey];
    delete next[fromKey];
  }
  return next;
}

/**
 * The single rename on one side of the node: exactly one pin gone and one new pin, at the same
 * position, of the same type. Undefined for anything else.
 */
function singleRename(before: readonly GraphPin[], after: readonly GraphPin[]): [GraphPin, GraphPin] | undefined {
  const afterIds = new Set(after.map((entry) => entry.id));
  const beforeIds = new Set(before.map((entry) => entry.id));
  const removed = before.filter((entry) => !afterIds.has(entry.id));
  const added = after.filter((entry) => !beforeIds.has(entry.id));
  if (removed.length !== 1 || added.length !== 1) return undefined;
  if (before.indexOf(removed[0]!) !== after.indexOf(added[0]!)) return undefined;
  return [removed[0]!, added[0]!];
}

const sameType = (a: GraphPin, b: GraphPin) => a.type.kind === b.type.kind;

/**
 * The node's properties after its formula becomes `formula`, and the pin ids that follow a rename.
 * A formula that does not parse keeps the pins of the last one that did (`pinFormula`). On each side
 * a variable renamed in place (one name gone, one new at the same position, same type) keeps its
 * wires, stored default and type choices; inputs and outputs that disappear lose theirs.
 */
export function mathExpressionFormulaEdit(
  properties: Record<string, unknown>,
  formula: string,
): { properties: Record<string, unknown>; renames: MathExpressionPinRenames } {
  const beforePins = mathExpressionPins(properties);
  let next: Record<string, unknown> = { ...properties, formula };
  if (parseMathExpression(formula).ok) {
    delete next.pinFormula;
  } else {
    const previous = mathExpressionFormula(properties);
    const lastGood = parseMathExpression(previous).ok ? previous : properties.pinFormula;
    if (typeof lastGood === "string") next.pinFormula = lastGood;
    else delete next.pinFormula;
    return { properties: next, renames: new Map() };
  }
  const renames = new Map<string, string>();
  const side = (direction: "in" | "out") => (pins: readonly GraphPin[]) => pins.filter((entry) => entry.direction === direction);
  const inputRename = singleRename(side("in")(beforePins), side("in")(mathExpressionPins(next)));
  if (inputRename) {
    const [from, to] = inputRename;
    const renamed = renameInput(next, from.name, to.name);
    const moved = mathExpressionPins(renamed).find((entry) => entry.id === to.id);
    if (moved && sameType(from, moved)) {
      next = renamed;
      renames.set(from.id, to.id);
    }
  }
  const afterPins = mathExpressionPins(next);
  const outputRename = singleRename(side("out")(beforePins), side("out")(afterPins));
  if (outputRename && sameType(outputRename[0], outputRename[1])) renames.set(outputRename[0].id, outputRename[1].id);
  // Choices and defaults of inputs the formula no longer has go with them.
  const inputNames = new Set(afterPins.filter((entry) => entry.direction === "in").map((entry) => entry.name));
  for (const key of ["inputTypes", "wiredInputTypes"] as const) {
    const record = typeRecord(next[key]);
    const kept = Object.fromEntries(Object.entries(record).filter(([name]) => inputNames.has(name)));
    if (Object.keys(kept).length > 0) next[key] = kept;
    else delete next[key];
  }
  const inputPrefix = pinDefaultPropertyKey(mathExpressionInputPinId(""));
  for (const key of Object.keys(next)) {
    if (key.startsWith(inputPrefix) && !inputNames.has(key.slice(inputPrefix.length))) delete next[key];
  }
  return { properties: next, renames };
}

type EditableNode = { id: string; data: Record<string, unknown> };
type EditableEdge = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };

/**
 * A Math Expression formula edit as one graph change: the node's new properties (with `__pins`
 * when its data carries them) and its wires, renamed where a variable was renamed and dropped where
 * a pin disappeared. Returns undefined when `nodeId` is not a Math Expression node.
 */
export function editMathExpressionFormula<N extends EditableNode, E extends EditableEdge>(
  nodes: readonly N[],
  edges: readonly E[],
  nodeId: string,
  formula: string,
  typeIdOf: (node: N) => string,
): { nodes: N[]; edges: E[] } | undefined {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node || typeIdOf(node) !== MATH_EXPRESSION_NODE_ID) return undefined;
  const hydrated = Array.isArray(node.data.__pins);
  const rest = { ...node.data };
  delete rest.__pins;
  const { properties, renames } = mathExpressionFormulaEdit(rest, formula);
  const pins = mathExpressionPins(properties);
  const pinIds = new Set(pins.map((entry) => entry.id));
  const nextNode = { ...node, data: hydrated ? { ...properties, __pins: pins } : properties };
  const nextEdges: E[] = [];
  for (const edge of edges) {
    let next = edge;
    if (edge.target === nodeId && edge.targetHandle) {
      const handle = renames.get(edge.targetHandle) ?? edge.targetHandle;
      if (!pinIds.has(handle)) continue;
      if (handle !== edge.targetHandle) next = { ...next, targetHandle: handle };
    }
    if (edge.source === nodeId && edge.sourceHandle) {
      const handle = renames.get(edge.sourceHandle) ?? edge.sourceHandle;
      if (!pinIds.has(handle)) continue;
      if (handle !== edge.sourceHandle) next = { ...next, sourceHandle: handle };
    }
    nextEdges.push(next);
  }
  return { nodes: nodes.map((entry) => entry === node ? nextNode : entry), edges: nextEdges };
}

/**
 * Inputs whose type follows their wire take the type wired into them (Integer as Float), as a
 * numeric operator's operands do: an input with no recorded type takes the wire's, and a recorded
 * one changes only to a type the wire's is not assignable to. An input whose type changes loses its
 * stored default. Inputs with an Inspector type ignore wires. Returns `properties` itself when
 * nothing changes.
 */
export function retypeMathExpressionInputs(
  properties: Record<string, unknown>,
  wiredType: (pinId: string) => PinType | undefined,
): Record<string, unknown> {
  const analysis = mathExpressionNodeState(properties).pins;
  if (!analysis) return properties;
  const wired = typeRecord(properties.wiredInputTypes);
  let changes: Array<[string, MathType]> | undefined;
  for (const input of analysis.signature.inputs) {
    if (mathExpressionExplicitInputType(properties, input.name)) continue;
    const type = mathTypeOfPinType(wiredType(mathExpressionInputPinId(input.name)));
    if (!type) continue;
    const before = Object.hasOwn(wired, input.name) ? wired[input.name] : undefined;
    if (before === type) continue;
    (changes ??= []).push([input.name, type]);
  }
  if (!changes) return properties;
  const next: Record<string, unknown> = { ...properties, wiredInputTypes: { ...wired } };
  for (const [name, type] of changes) {
    const before = mathExpressionInputType(properties, name);
    (next.wiredInputTypes as Record<string, MathType>)[name] = type;
    if (before !== type) delete next[pinDefaultPropertyKey(mathExpressionInputPinId(name))];
  }
  return next;
}

/**
 * What choosing `type` for input `name` in the Inspector writes: the type (undefined returns the
 * input to following its wire), and no stored default when the type changes.
 */
export function mathExpressionInputTypePatch(
  properties: Record<string, unknown>,
  name: string,
  type: MathType | undefined,
): Record<string, unknown> {
  const explicit = { ...typeRecord(properties.inputTypes) };
  if (type) explicit[name] = type;
  else delete explicit[name];
  const before = mathExpressionInputType(properties, name);
  const after = mathExpressionInputType({ ...properties, inputTypes: explicit }, name);
  return {
    inputTypes: Object.keys(explicit).length > 0 ? explicit : undefined,
    ...(before !== after ? { [pinDefaultPropertyKey(mathExpressionInputPinId(name))]: undefined } : {}),
  };
}
