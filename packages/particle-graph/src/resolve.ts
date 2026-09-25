import {
  particleNodeDefinitionFor,
  type ParticleNodeDefinition,
  type ParticlePinDefinition,
} from "./catalog";
import type { ParticleGraphEdge, ParticleGraphNode } from "./document";
import {
  PARTICLE_NUMERIC_TYPES,
  resolveParticleGenericType,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";

export interface ParticleResolverGraph {
  nodes: readonly ParticleGraphNode[];
  edges: readonly ParticleGraphEdge[];
}

export interface ParticleTypeResolver {
  definitionOf(nodeId: string): ParticleNodeDefinition | undefined;
  outputType(nodeId: string, pinId: string): ParticleValueType | null;
  inputType(nodeId: string, pinId: string): ParticleValueType | null;
  /** Resolved generic group, `"conflict"` when inputs disagree, or undefined. */
  genericOf(nodeId: string): ParticleNumericType | "conflict" | undefined;
  conflicts(): string[];
}

/** Types the node's generic group accepts, and its unwired type. */
export function particleGenericGroup(
  definition: ParticleNodeDefinition,
): { accepts: readonly ParticleNumericType[]; fallback: ParticleNumericType } | null {
  const pin = [...definition.inputs, ...definition.outputs].find(
    (entry) => entry.type.kind === "generic",
  );
  if (!pin || pin.type.kind !== "generic") return null;
  return {
    accepts: pin.type.accepts ?? PARTICLE_NUMERIC_TYPES,
    fallback: pin.type.fallback ?? "float",
  };
}

function pinById(
  pins: readonly ParticlePinDefinition[],
  id: string,
): ParticlePinDefinition | undefined {
  return pins.find((pin) => pin.id === id);
}

/**
 * Lazy type resolution over one graph. A generic group resolves from the
 * non-Float types wired into it, so a chain of generic nodes carries a vector
 * width all the way down. Particle wires never take part in resolution; the
 * validator reports them on the edge.
 */
export function createParticleTypeResolver(
  graph: ParticleResolverGraph,
): ParticleTypeResolver {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Map<string, ParticleNodeDefinition | undefined>();
  const generics = new Map<string, ParticleNumericType | "conflict">();
  const inProgress = new Set<string>();

  const definitionOf = (nodeId: string): ParticleNodeDefinition | undefined => {
    if (definitions.has(nodeId)) return definitions.get(nodeId);
    const node = nodesById.get(nodeId);
    const definition = node ? particleNodeDefinitionFor(node) : undefined;
    definitions.set(nodeId, definition);
    return definition;
  };

  const genericOf = (nodeId: string): ParticleNumericType | "conflict" | undefined => {
    const cached = generics.get(nodeId);
    if (cached !== undefined) return cached;
    const definition = definitionOf(nodeId);
    if (!definition) return undefined;
    const group = particleGenericGroup(definition);
    if (!group) return undefined;
    // A cycle is reported separately; stop the recursion here.
    if (inProgress.has(nodeId)) return "conflict";
    inProgress.add(nodeId);
    const connected: ParticleValueType[] = [];
    for (const pin of definition.inputs) {
      if (pin.type.kind !== "generic") continue;
      const edge = graph.edges.find(
        (candidate) => candidate.targetNodeId === nodeId && candidate.targetPinId === pin.id,
      );
      if (!edge) continue;
      const sourceType = outputType(edge.sourceNodeId, edge.sourcePinId);
      if (sourceType && sourceType !== "particle") connected.push(sourceType);
    }
    inProgress.delete(nodeId);
    const resolution = resolveParticleGenericType(connected, group.fallback);
    const value = resolution.ok ? resolution.type : "conflict";
    generics.set(nodeId, value);
    return value;
  };

  function pinType(
    nodeId: string,
    pin: ParticlePinDefinition | undefined,
  ): ParticleValueType | null {
    if (!pin) return null;
    if (pin.type.kind !== "generic") return pin.type.kind;
    const resolved = genericOf(nodeId);
    return resolved && resolved !== "conflict" ? resolved : null;
  }

  function outputType(nodeId: string, pinId: string): ParticleValueType | null {
    const definition = definitionOf(nodeId);
    return definition ? pinType(nodeId, pinById(definition.outputs, pinId)) : null;
  }

  function inputType(nodeId: string, pinId: string): ParticleValueType | null {
    const definition = definitionOf(nodeId);
    return definition ? pinType(nodeId, pinById(definition.inputs, pinId)) : null;
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
