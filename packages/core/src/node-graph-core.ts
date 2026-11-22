/**
 * Graph primitives Material graphs (`@haptic/shader-graph`) and Particle graphs (`@haptic/particle-graph`) share:
 * serialized node and edge sanitising, the first-edge index of input pins, pin lookup, and the lazy generic pin type
 * resolver. Each package keeps its own catalog, type rules and diagnostics; only the algorithms live here.
 */

/** A wire from one node's output pin to another node's input pin, as Material and Particle graphs store it. */
export interface GraphPinEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

/** A sanitised graph node: a non-empty type, an id, a finite position and its properties. */
export interface GraphDocumentNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Serialized edges that name both ends; others are dropped, and an edge without an id gets `edge-<index>`. */
export function normalizeGraphPinEdges(value: unknown): GraphPinEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const fields = record(entry);
    const sourceNodeId = text(fields.sourceNodeId);
    const sourcePinId = text(fields.sourcePinId);
    const targetNodeId = text(fields.targetNodeId);
    const targetPinId = text(fields.targetPinId);
    if (!sourceNodeId || !sourcePinId || !targetNodeId || !targetPinId) return [];
    return [{ id: text(fields.id) || `edge-${index}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId }];
  });
}

/**
 * Serialized nodes that name a type; others are dropped. A node without an id gets `node-<index>`, a missing or
 * non-finite position coordinate 0, and its properties (an object, else empty) pass through `properties`, which
 * applies the graph's own per-type rules.
 */
export function normalizeGraphNodes(
  value: unknown,
  properties: (type: string, authored: Record<string, unknown>) => Record<string, unknown>,
): GraphDocumentNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const fields = record(entry);
    const type = text(fields.type);
    if (!type) return [];
    const position = record(fields.position);
    return [{
      id: text(fields.id) || `node-${index}`,
      type,
      position: { x: finite(position.x), y: finite(position.y) },
      properties: properties(type, record(fields.properties)),
    }];
  });
}

/** The ends of a wire the incoming index reads. */
export interface PinEdgeTarget {
  readonly targetNodeId: string;
  readonly targetPinId: string;
}

/** The edge into an input pin; undefined when the pin is unwired. */
export type IncomingPinEdges<E> = (nodeId: string, pinId: string) => E | undefined;

/**
 * The first edge into each input pin, in one pass over `edges`, so a pin wired twice (a validation error) resolves
 * as `edges.find` would.
 */
export function indexIncomingPinEdges<E extends PinEdgeTarget>(edges: readonly E[]): IncomingPinEdges<E> {
  const byNode = new Map<string, Map<string, E>>();
  for (const edge of edges) {
    let pins = byNode.get(edge.targetNodeId);
    if (!pins) byNode.set(edge.targetNodeId, (pins = new Map()));
    if (!pins.has(edge.targetPinId)) pins.set(edge.targetPinId, edge);
  }
  return (nodeId, pinId) => byNode.get(nodeId)?.get(pinId);
}

/** The pin with `id` among `pins`, without allocating a predicate per lookup. */
export function findPin<P extends { readonly id: string }>(pins: readonly P[], id: string): P | undefined {
  for (const pin of pins) if (pin.id === id) return pin;
  return undefined;
}

/** A pin as the resolver reads it: concrete (`kind` is its type), `generic` (its node's group) or `wildcard`. */
export interface ResolvablePin {
  readonly id: string;
  readonly type: { readonly kind: string };
}

export interface ResolvableDefinition<P extends ResolvablePin> {
  readonly inputs: readonly P[];
  readonly outputs: readonly P[];
}

export interface PinTypeResolverSpec<
  N extends { readonly id: string },
  E extends PinEdgeTarget & { readonly sourceNodeId: string; readonly sourcePinId: string },
  P extends ResolvablePin,
  D extends ResolvableDefinition<P>,
  T extends string,
  G,
> {
  nodes: readonly N[];
  edges: readonly E[];
  /** An index of `edges` built already (`indexIncomingPinEdges`); otherwise one is built on the first generic lookup. */
  incoming?: IncomingPinEdges<NoInfer<E>>;
  /** `node`'s definition, asked once per node. It may call back into the resolver (a type it mirrors). */
  definition(node: NoInfer<N>): D | undefined;
  /** `definition`'s generic group, or null when none of its pins is generic: the node then never resolves. */
  group(definition: D): G | null;
  /** Whether a wired source type takes part in its target's generic group; others are skipped (default: all). */
  contributes?(type: T): boolean;
  /** The group's type from the types wired into its generic inputs, in pin order, or `"conflict"`. */
  resolve(connected: readonly T[], group: G): T | "conflict";
  /** What a `wildcard` pin reads as. */
  wildcard: T | null;
}

export interface PinTypeResolver<N, E, D, T> {
  definitionOf(nodeId: string): D | undefined;
  outputType(nodeId: string, pinId: string): T | null;
  inputType(nodeId: string, pinId: string): T | null;
  /** The node's resolved generic group, `"conflict"` when its inputs disagree (or loop), or undefined without one. */
  genericOf(nodeId: string): T | "conflict" | undefined;
  /** Ids of the nodes whose generic group is in conflict, resolving every node. */
  conflicts(): string[];
  /** The graph's node with `nodeId` (the last of that id). */
  node(nodeId: string): N | undefined;
  /** The first edge into an input pin. */
  incoming: IncomingPinEdges<E>;
}

/**
 * Lazy pin type resolution over one graph. A generic node resolves from the types actually wired into its generic
 * inputs, each source resolved on demand and every answer memoised, so a chain of generic nodes carries a vector
 * width all the way down and each node resolves once. A node reached again while it resolves (a cycle, which
 * validation reports) reads as a conflict instead of recursing.
 */
export function createPinTypeResolver<
  N extends { readonly id: string },
  E extends PinEdgeTarget & { readonly sourceNodeId: string; readonly sourcePinId: string },
  P extends ResolvablePin,
  D extends ResolvableDefinition<P>,
  T extends string,
  G,
>(spec: PinTypeResolverSpec<N, E, P, D, T, G>): PinTypeResolver<N, E, D, T> {
  const nodesById = new Map<string, N>();
  for (const node of spec.nodes) nodesById.set(node.id, node);
  const definitions = new Map<string, D | undefined>();
  const generics = new Map<string, T | "conflict">();
  const inProgress = new Set<string>();
  let index: IncomingPinEdges<E> | undefined;
  const incoming: IncomingPinEdges<E> = spec.incoming ??
    ((nodeId, pinId) => (index ??= indexIncomingPinEdges(spec.edges))(nodeId, pinId));

  function definitionOf(nodeId: string): D | undefined {
    if (definitions.has(nodeId)) return definitions.get(nodeId);
    const node = nodesById.get(nodeId);
    const definition = node ? spec.definition(node) : undefined;
    definitions.set(nodeId, definition);
    return definition;
  }

  function genericOf(nodeId: string): T | "conflict" | undefined {
    const cached = generics.get(nodeId);
    if (cached !== undefined) return cached;
    const definition = definitionOf(nodeId);
    if (!definition) return undefined;
    const group = spec.group(definition);
    if (group === null) return undefined;
    // A cycle is reported separately; stop the recursion here.
    if (inProgress.has(nodeId)) return "conflict";
    inProgress.add(nodeId);
    const connected: T[] = [];
    for (const pin of definition.inputs) {
      if (pin.type.kind !== "generic") continue;
      const edge = incoming(nodeId, pin.id);
      if (!edge) continue;
      const sourceType = outputType(edge.sourceNodeId, edge.sourcePinId);
      if (sourceType && (!spec.contributes || spec.contributes(sourceType))) connected.push(sourceType);
    }
    inProgress.delete(nodeId);
    const value = spec.resolve(connected, group);
    generics.set(nodeId, value);
    return value;
  }

  function pinType(nodeId: string, pin: P | undefined): T | null {
    if (!pin) return null;
    const kind = pin.type.kind;
    if (kind === "wildcard") return spec.wildcard;
    if (kind !== "generic") return kind as T;
    const resolved = genericOf(nodeId);
    return resolved && resolved !== "conflict" ? resolved : null;
  }

  function outputType(nodeId: string, pinId: string): T | null {
    const definition = definitionOf(nodeId);
    return definition ? pinType(nodeId, findPin(definition.outputs, pinId)) : null;
  }

  function inputType(nodeId: string, pinId: string): T | null {
    const definition = definitionOf(nodeId);
    return definition ? pinType(nodeId, findPin(definition.inputs, pinId)) : null;
  }

  return {
    definitionOf,
    outputType,
    inputType,
    genericOf,
    conflicts: () => {
      for (const node of spec.nodes) genericOf(node.id);
      const ids: string[] = [];
      for (const [nodeId, value] of generics) if (value === "conflict") ids.push(nodeId);
      return ids;
    },
    node: (nodeId) => nodesById.get(nodeId),
    incoming,
  };
}
