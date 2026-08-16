import {
  materialNodeDefinition,
  type MaterialNodeDefinition,
} from "./catalog";
import type {
  MaterialFunctionDocument,
  MaterialGraphEdge,
  MaterialGraphNode,
} from "./document";
import { resolveGenericType, type MaterialValueType } from "./types";

export interface ResolverGraph {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
}

export interface TypeResolverOptions {
  functions?: Record<string, MaterialFunctionDocument>;
  /** Interface of the function this graph is the body of, if any. */
  functionInterface?: MaterialFunctionDocument;
}

export interface TypeResolver {
  definitionOf(nodeId: string): MaterialNodeDefinition | undefined;
  outputType(nodeId: string, pinId: string): MaterialValueType | null;
  inputType(nodeId: string, pinId: string): MaterialValueType | null;
  /** Resolved generic group, `"conflict"` when inputs disagree, or undefined. */
  genericOf(nodeId: string): MaterialValueType | "conflict" | undefined;
  conflicts(): string[];
}

/** Call node pins mirror the callee's declared interface. */
function callDefinition(
  base: MaterialNodeDefinition,
  fn: MaterialFunctionDocument,
): MaterialNodeDefinition {
  return {
    ...base,
    title: fn.name,
    inputs: fn.inputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
      ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    })),
    outputs: fn.outputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
    })),
  };
}

function plumbingDefinition(
  base: MaterialNodeDefinition,
  type: "function.input" | "function.output",
  fn: MaterialFunctionDocument,
): MaterialNodeDefinition {
  const pins = (type === "function.input" ? fn.inputs : fn.outputs).map(
    (pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type } as const,
      ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    }),
  );
  return type === "function.input"
    ? { ...base, inputs: [], outputs: pins }
    : { ...base, inputs: pins, outputs: [] };
}

/**
 * Lazy type resolution over one graph. Generic nodes resolve from the types
 * actually wired in, so a chain of generic nodes propagates a vector width all
 * the way down instead of collapsing to Float at the first hop.
 */
export function createTypeResolver(
  graph: ResolverGraph,
  options: TypeResolverOptions = {},
): TypeResolver {
  const functions = options.functions ?? {};
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Map<string, MaterialNodeDefinition | undefined>();
  const generics = new Map<string, MaterialValueType | "conflict">();
  const inProgress = new Set<string>();

  const definitionOf = (
    nodeId: string,
  ): MaterialNodeDefinition | undefined => {
    if (definitions.has(nodeId)) return definitions.get(nodeId);
    const node = nodesById.get(nodeId);
    let definition = node ? materialNodeDefinition(node.type) : undefined;
    if (node && definition) {
      if (node.type === "function.call") {
        const guid = node.properties.functionGuid;
        const fn = typeof guid === "string" ? functions[guid] : undefined;
        if (fn) definition = callDefinition(definition, fn);
      } else if (
        (node.type === "function.input" || node.type === "function.output") &&
        options.functionInterface
      ) {
        definition = plumbingDefinition(
          definition,
          node.type,
          options.functionInterface,
        );
      }
    }
    definitions.set(nodeId, definition);
    return definition;
  };

  const genericOf = (
    nodeId: string,
  ): MaterialValueType | "conflict" | undefined => {
    const cached = generics.get(nodeId);
    if (cached !== undefined) return cached;
    const definition = definitionOf(nodeId);
    if (!definition) return undefined;
    const genericInputs = definition.inputs.filter(
      (pin) => pin.type.kind === "generic",
    );
    if (genericInputs.length === 0) return undefined;
    if (inProgress.has(nodeId)) {
      // A cycle is reported separately; stop the recursion here.
      return "conflict";
    }
    inProgress.add(nodeId);
    const connected: MaterialValueType[] = [];
    for (const pin of genericInputs) {
      const edge = graph.edges.find(
        (candidate) =>
          candidate.targetNodeId === nodeId && candidate.targetPinId === pin.id,
      );
      if (!edge) continue;
      const sourceType = outputType(edge.sourceNodeId, edge.sourcePinId);
      if (sourceType) connected.push(sourceType);
    }
    inProgress.delete(nodeId);
    const resolution = resolveGenericType(connected);
    const value = resolution.ok ? resolution.type : "conflict";
    generics.set(nodeId, value);
    return value;
  };

  function outputType(
    nodeId: string,
    pinId: string,
  ): MaterialValueType | null {
    const definition = definitionOf(nodeId);
    if (!definition) return null;
    const pin = definition.outputs.find((entry) => entry.id === pinId);
    if (!pin) return null;
    if (pin.type.kind !== "generic") return pin.type.kind;
    const resolved = genericOf(nodeId);
    return resolved && resolved !== "conflict" ? resolved : null;
  }

  function inputType(nodeId: string, pinId: string): MaterialValueType | null {
    const definition = definitionOf(nodeId);
    if (!definition) return null;
    const pin = definition.inputs.find((entry) => entry.id === pinId);
    if (!pin) return null;
    if (pin.type.kind !== "generic") return pin.type.kind;
    const resolved = genericOf(nodeId);
    return resolved && resolved !== "conflict" ? resolved : null;
  }

  return {
    definitionOf,
    outputType,
    inputType,
    genericOf,
    conflicts: () => {
      for (const node of graph.nodes) genericOf(node.id);
      return [...generics.entries()]
        .filter(([, value]) => value === "conflict")
        .map(([nodeId]) => nodeId);
    },
  };
}
