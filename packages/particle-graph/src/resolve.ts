import { createPinTypeResolver, type IncomingPinEdges, type PinTypeResolver } from "@haptic/core";
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

/** Pin types of one Particle graph, with the node and incoming-edge lookups validation and lowering reuse. */
export interface ParticleTypeResolver
  extends PinTypeResolver<ParticleGraphNode, ParticleGraphEdge, ParticleNodeDefinition, ParticleValueType> {
  /** Resolved generic group, `"conflict"` when inputs disagree, or undefined. */
  genericOf(nodeId: string): ParticleNumericType | "conflict" | undefined;
}

type ParticleGenericGroup = { accepts: readonly ParticleNumericType[]; fallback: ParticleNumericType };

/** Types the node's generic group accepts, and its unwired type. */
export function particleGenericGroup(definition: ParticleNodeDefinition): ParticleGenericGroup | null {
  return genericGroupOf(definition.inputs) ?? genericGroupOf(definition.outputs);
}

function genericGroupOf(pins: readonly ParticlePinDefinition[]): ParticleGenericGroup | null {
  for (const pin of pins) {
    if (pin.type.kind === "generic") {
      return { accepts: pin.type.accepts ?? PARTICLE_NUMERIC_TYPES, fallback: pin.type.fallback ?? "float" };
    }
  }
  return null;
}

/**
 * Lazy type resolution over one graph (`createPinTypeResolver`). A generic group resolves from the
 * non-Float types wired into it, so a chain of generic nodes carries a vector width all the way down.
 * Particle wires never take part in resolution; the validator reports them on the edge. A Reroute's
 * wildcard pin has no type of its own: graphs are collapsed before they are resolved. `incoming`
 * shares an index of `graph.edges` built already.
 */
export function createParticleTypeResolver(
  graph: ParticleResolverGraph,
  incoming?: IncomingPinEdges<ParticleGraphEdge>,
): ParticleTypeResolver {
  return createPinTypeResolver<
    ParticleGraphNode, ParticleGraphEdge, ParticlePinDefinition, ParticleNodeDefinition, ParticleValueType, ParticleGenericGroup
  >({
    nodes: graph.nodes,
    edges: graph.edges,
    incoming,
    definition: particleNodeDefinitionFor,
    group: particleGenericGroup,
    contributes: (type: ParticleValueType) => type !== "particle",
    resolve: (connected: readonly ParticleValueType[], group: ParticleGenericGroup) => {
      const resolution = resolveParticleGenericType(connected, group.fallback);
      return resolution.ok ? resolution.type : "conflict";
    },
    wildcard: null,
  }) as ParticleTypeResolver;
}
