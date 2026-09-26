import type { SerializedGraph } from "@babylonslate/core";
import {
  PARTICLE_UNSUPPORTED_V1_TYPES,
  particleNodeDefinition,
  particleNodeDefinitionFor,
  particlePaletteEntries,
  type ParticleNodeRole,
  type ParticlePinDefinition,
} from "./catalog";
import {
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  type ParticleGraphDocument,
} from "./document";
import { createParticleTypeResolver } from "./resolve";
import {
  PARTICLE_NUMERIC_TYPES,
  isParticleNumericType,
  isParticleValueType,
  particleTypesAreAssignable,
  type ParticleNumericType,
} from "./types";

/** Pin shape the shared graph shell renders and connects. */
export interface ParticleGraphPin {
  id: string;
  name: string;
  /** Particle pins are data pins: data inputs take one link, like Babylon's particle inputs. */
  kind: "data";
  direction: "in" | "out";
  type: { kind: string; accepts?: readonly ParticleNumericType[] };
  defaultValue?: number[];
  typeLabel?: string;
  description?: string;
}

function toPin(pin: ParticlePinDefinition, direction: "in" | "out"): ParticleGraphPin {
  return {
    id: pin.id,
    name: pin.name,
    kind: "data",
    direction,
    type:
      pin.type.kind === "generic"
        ? { kind: "generic", ...(pin.type.accepts ? { accepts: pin.type.accepts } : {}) }
        : { kind: pin.type.kind },
    ...(pin.defaultValue ? { defaultValue: [...pin.defaultValue] } : {}),
    ...(pin.description ? { description: pin.description } : {}),
  };
}

/** Catalog pins, inputs then outputs. Particle pins come first in each list. */
export function pinsForParticleNode(
  type: string,
  properties: Record<string, unknown> = {},
): ParticleGraphPin[] {
  const definition = particleNodeDefinitionFor({ type, properties });
  if (!definition) return [];
  return [
    ...definition.inputs.map((pin) => toPin(pin, "in")),
    ...definition.outputs.map((pin) => toPin(pin, "out")),
  ];
}

/** Keys hydrate adds (and graph-ui may add); dehydrate strips exactly these. */
const EDITOR_NODE_KEYS = new Set([
  "__pins",
  "__particleRole",
  "__nodeType",
  "__category",
  "__protected",
  "__pure",
  "__latent",
  "__editorOnly",
  "title",
]);

/** Saved node properties from canvas node data (editor-only keys removed). */
export function particleNodePropertiesFromData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!EDITOR_NODE_KEYS.has(key)) properties[key] = value;
  }
  return properties;
}

export interface ParticlePaletteNode {
  id: string;
  title: string;
  category: string;
  description?: string;
  searchAliases?: readonly string[];
  pins: ParticleGraphPin[];
  /** Starting properties plus `__particleRole`, so the palette chip matches the header. */
  defaultData: Record<string, unknown>;
}

/** Add Node entries in palette order; the Emitter Output is never offered. */
export function particlePaletteNodes(): ParticlePaletteNode[] {
  return particlePaletteEntries().map((definition) => {
    const properties = newParticleNodeProperties(definition.type);
    return {
      id: definition.type,
      title: definition.title,
      category: definition.category,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.searchAliases ? { searchAliases: definition.searchAliases } : {}),
      pins: pinsForParticleNode(definition.type, properties),
      defaultData: { ...properties, __particleRole: definition.role },
    };
  });
}

export function particleGraphToSerialized(doc: ParticleGraphDocument): SerializedGraph {
  return {
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { ...node.position },
      data: { ...node.properties },
    })),
    edges: doc.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: edge.sourcePinId,
      targetHandle: edge.targetPinId,
    })),
  };
}

/**
 * Fold canvas edits back into the document. Name, Material and settings are
 * not on the canvas and always come from `previous`.
 */
export function serializedToParticleGraph(
  graph: SerializedGraph,
  previous?: ParticleGraphDocument,
): ParticleGraphDocument {
  const base = previous ?? normalizeParticleGraphDocument({});
  return normalizeParticleGraphDocument(
    {
      ...base,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        properties: particleNodePropertiesFromData(node.data),
      })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.source,
        targetNodeId: edge.target,
        sourcePinId: edge.sourceHandle ?? "out",
        targetPinId: edge.targetHandle ?? "in",
      })),
    },
    base.name,
  );
}

function typeLabel(kind: string): string {
  switch (kind) {
    case "float":
      return "Float";
    case "vec2":
      return "V2";
    case "vec3":
      return "V3";
    case "color":
      return "Color";
    case "particle":
      return "Particle";
    default:
      return "Numeric";
  }
}

/**
 * Inject catalog pins, titles and the header role so the canvas can draw and
 * connect nodes. Generic pins show their resolved type once a non-Float input
 * is wired; until then they keep their accepted types, even when the group
 * falls back to a non-Float type (Split lowers as Color). The Emitter Output
 * is protected from deletion.
 */
export function hydrateParticleGraphForEditor(graph: SerializedGraph): SerializedGraph {
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePinId: edge.sourceHandle ?? "out",
    targetNodeId: edge.target,
    targetPinId: edge.targetHandle ?? "in",
  }));
  const resolver = createParticleTypeResolver({
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      properties: particleNodePropertiesFromData(node.data),
    })),
    edges,
  });
  /** A non-Float numeric type is wired into one of the node's generic inputs. */
  const resolvedFromWire = (nodeId: string): boolean => {
    const definition = resolver.definitionOf(nodeId);
    if (!definition) return false;
    return edges.some((edge) => {
      if (edge.targetNodeId !== nodeId) return false;
      const pin = definition.inputs.find((entry) => entry.id === edge.targetPinId);
      if (pin?.type.kind !== "generic") return false;
      const source = resolver.outputType(edge.sourceNodeId, edge.sourcePinId);
      return source !== null && source !== "float" && isParticleNumericType(source);
    });
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const properties = particleNodePropertiesFromData(node.data);
      const pins = pinsForParticleNode(node.type, properties);
      const wired = resolvedFromWire(node.id);
      for (const pin of pins) {
        const resolved =
          pin.direction === "in"
            ? resolver.inputType(node.id, pin.id)
            : resolver.outputType(node.id, pin.id);
        if (pin.type.kind !== "generic") {
          pin.typeLabel = typeLabel(resolved ?? pin.type.kind);
          continue;
        }
        if (wired && resolved) pin.type = { kind: resolved };
        // An unwired group keeps its accepted types; only a Float fallback reads as Float.
        pin.typeLabel = typeLabel(wired || resolved === "float" ? (resolved ?? "generic") : "generic");
      }
      const definition = resolver.definitionOf(node.id);
      return {
        ...node,
        data: {
          ...properties,
          __pins: pins,
          __nodeType: node.type,
          ...(definition
            ? { __particleRole: definition.role, __category: definition.category }
            : {}),
          ...(definition?.terminal ? { __protected: true } : {}),
          title: definition?.title ?? PARTICLE_UNSUPPORTED_V1_TYPES[node.type] ?? node.type,
        },
      };
    }),
  };
}

/** Header role for a canvas node or palette entry, if it is a particle node. */
export function particleNodeRole(type: string): ParticleNodeRole | undefined {
  return particleNodeDefinition(type)?.role;
}

type CanvasPin = { type: { kind: string; accepts?: unknown } };

function acceptedTypes(pin: CanvasPin): readonly string[] {
  const accepts = pin.type.accepts;
  return Array.isArray(accepts) ? (accepts as string[]) : PARTICLE_NUMERIC_TYPES;
}

/**
 * Canvas connection rule: Particle meets only Particle, a Float splats into a
 * vector or color, a generic input takes Float or one of its accepted types,
 * and vector widths never mix.
 */
export function particlePinsAreCompatible(outgoing: CanvasPin, incoming: CanvasPin): boolean {
  const from = outgoing.type.kind;
  const to = incoming.type.kind;
  if (from === "particle" || to === "particle") return from === to;
  if (to === "generic") {
    return from === "generic" || from === "float" || acceptedTypes(incoming).includes(from);
  }
  if (from === "generic") return isParticleNumericType(to);
  if (!isParticleValueType(from) || !isParticleValueType(to)) return from === to;
  return particleTypesAreAssignable(from, to);
}

type ConnectionGraph = {
  nodes: ReadonlyArray<{ id: string; type: string }>;
  edges: ReadonlyArray<{ source: string; target: string; sourceHandle?: string }>;
};

/**
 * Host veto after pin compatibility (`GraphEditor.canConnect`): a Particle
 * output feeds one input, which keeps the spine linear, and no connection may
 * close a loop.
 */
export function particleConnectionIsAllowed(
  graph: ConnectionGraph,
  connection: { source: string; target: string; sourceHandle: string; targetHandle: string },
): boolean {
  if (connection.source === connection.target) return false;
  const source = graph.nodes.find((node) => node.id === connection.source);
  const sourcePin = source
    ? particleNodeDefinition(source.type)?.outputs.find((pin) => pin.id === connection.sourceHandle)
    : undefined;
  if (
    sourcePin?.type.kind === "particle" &&
    graph.edges.some(
      (edge) => edge.source === connection.source && (edge.sourceHandle ?? "out") === connection.sourceHandle,
    )
  ) {
    return false;
  }
  // Adding source → target closes a loop when target already reaches source.
  const seen = new Set<string>();
  const stack = [connection.target];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (nodeId === connection.source) return false;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    for (const edge of graph.edges) {
      if (edge.source === nodeId) stack.push(edge.target);
    }
  }
  return true;
}
