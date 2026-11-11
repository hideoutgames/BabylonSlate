import { globalParameterNodeTitle, type GlobalParameterCatalog, type SerializedGraph } from "@haptic/core";
import { PARTICLE_GLOBAL_PARAMETER_NODE_TYPE } from "./global-parameter";
import {
  PARTICLE_PARAMETER_NODE_TYPE,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  particleNodeDefinitionFor,
  particlePaletteEntries,
  type ParticlePinDefinition,
} from "./catalog";
import {
  type ParticleGraphParameter,
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  type ParticleGraphDocument,
} from "./document";
import {
  particleParameterSnapshot,
  type ParticleParameterSnapshot,
} from "./parameter-nodes";
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
  /** `fallback` is the type an unwired generic group edits and lowers as. */
  type: { kind: string; accepts?: readonly ParticleNumericType[]; fallback?: ParticleNumericType };
  defaultValue?: number[];
  min?: number;
  max?: number;
  typeLabel?: string;
  description?: string;
  /** Particle outputs feed one input: a new wire from one replaces its old wire. */
  singleLink?: true;
}

function toPin(pin: ParticlePinDefinition, direction: "in" | "out"): ParticleGraphPin {
  return {
    id: pin.id,
    name: pin.name,
    kind: "data",
    direction,
    type:
      pin.type.kind === "generic"
        ? {
            kind: "generic",
            ...(pin.type.accepts ? { accepts: pin.type.accepts } : {}),
            ...(pin.type.fallback ? { fallback: pin.type.fallback } : {}),
          }
        : { kind: pin.type.kind },
    ...(pin.defaultValue ? { defaultValue: [...pin.defaultValue] } : {}),
    ...(pin.min !== undefined ? { min: pin.min } : {}),
    ...(pin.max !== undefined ? { max: pin.max } : {}),
    ...(pin.description ? { description: pin.description } : {}),
    ...(direction === "out" && pin.type.kind === "particle" ? { singleLink: true as const } : {}),
  };
}

/** Catalog pins, inputs then outputs. Particle pins come first in each list. */
function pinsForParticleNode(
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

/**
 * Canvas data key of a Parameter node's {@link ParticleParameterSnapshot}. Copies carry it,
 * so a paste can declare the parameter again where it is missing.
 */
const PARTICLE_PARAMETER_SNAPSHOT_KEY = "__parameter";

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
  PARTICLE_PARAMETER_SNAPSHOT_KEY,
  "title",
]);

/** Saved node properties from canvas node data (editor-only keys removed). */
function particleNodePropertiesFromData(
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
  /** The node type when `id` names one entry of several for it (one Parameter entry per value type). */
  nodeType?: string;
  title: string;
  category: string;
  description?: string;
  searchAliases?: readonly string[];
  pins: ParticleGraphPin[];
  /** Starting properties plus `__particleRole`, so the palette chip matches the header. */
  defaultData: Record<string, unknown>;
}

/** Add Node **Parameter** entries that place a Parameter node of a new parameter, one per value type. */
const NEW_PARAMETER_ENTRIES: readonly { type: ParticleNumericType; title: string }[] = [
  { type: "float", title: "Float Parameter" },
  { type: "vec2", title: "Vector2 Parameter" },
  { type: "vec3", title: "Vector3 Parameter" },
  { type: "color", title: "Color Parameter" },
];

/** Add Node category of the Parameter entries. */
const PARTICLE_PARAMETER_CATEGORY = "Parameter";

function snapshotOf(parameter: ParticleGraphParameter): ParticleParameterSnapshot {
  return { name: parameter.name, type: parameter.type, defaultValue: [...parameter.defaultValue] };
}

/**
 * Add Node entries in palette order; the Emitter Output is never offered. The **Parameter**
 * category follows **Constants** with one new-parameter entry per value type: each node reads
 * its own parameter, so existing parameters are not offered again.
 */
export function particlePaletteNodes(): ParticlePaletteNode[] {
  const parameterEntries = NEW_PARAMETER_ENTRIES.map(({ type, title }): ParticlePaletteNode => {
    const properties = { parameterId: "", valueType: type };
    return {
      id: `${PARTICLE_PARAMETER_NODE_TYPE}:new:${type}`,
      nodeType: PARTICLE_PARAMETER_NODE_TYPE,
      title,
      category: PARTICLE_PARAMETER_CATEGORY,
      description: "Adds a new parameter of this type. Name it and set its default in the Inspector.",
      searchAliases: ["parameter", "new parameter"],
      pins: pinsForParticleNode(PARTICLE_PARAMETER_NODE_TYPE, properties),
      defaultData: { ...properties, __particleRole: "input" },
    };
  });
  const entries = particlePaletteEntries().map((definition): ParticlePaletteNode => {
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
  let afterConstants = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.category === "Constants") {
      afterConstants = index + 1;
      break;
    }
  }
  return [...entries.slice(0, afterConstants), ...parameterEntries, ...entries.slice(afterConstants)];
}

/** Parameter snapshots by node id from canvas data (see {@link PARTICLE_PARAMETER_SNAPSHOT_KEY}). */
export function particleParameterSnapshots(graph: SerializedGraph): Map<string, ParticleParameterSnapshot> {
  const snapshots = new Map<string, ParticleParameterSnapshot>();
  for (const node of graph.nodes) {
    if (node.type !== PARTICLE_PARAMETER_NODE_TYPE) continue;
    const snapshot = particleParameterSnapshot(node.data[PARTICLE_PARAMETER_SNAPSHOT_KEY]);
    if (snapshot) snapshots.set(node.id, snapshot);
  }
  return snapshots;
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
        sourcePinId: edge.sourceHandle,
        targetPinId: edge.targetHandle,
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
export function hydrateParticleGraphForEditor(
  graph: SerializedGraph,
  /** A Parameter node is titled with its parameter's name. */
  parameters: readonly ParticleGraphParameter[] = [],
  /** The project's Global Parameter Collections, which title Global Parameter nodes. */
  globalParameters?: Readonly<GlobalParameterCatalog>,
): SerializedGraph {
  const declared = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePinId: edge.sourceHandle ?? "",
    targetNodeId: edge.target,
    targetPinId: edge.targetHandle ?? "",
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
      const parameter = node.type === PARTICLE_PARAMETER_NODE_TYPE
        ? declared.get(String(properties.parameterId ?? ""))
        : undefined;
      return {
        ...node,
        data: {
          ...properties,
          ...(parameter ? { [PARTICLE_PARAMETER_SNAPSHOT_KEY]: snapshotOf(parameter) } : {}),
          __pins: pins,
          __nodeType: node.type,
          ...(definition
            ? { __particleRole: definition.role, __category: definition.category }
            : {}),
          ...(definition?.terminal ? { __protected: true } : {}),
          title: node.type === PARTICLE_GLOBAL_PARAMETER_NODE_TYPE
            ? globalParameterNodeTitle(properties, globalParameters)
            : parameter?.name ?? definition?.title ?? PARTICLE_UNSUPPORTED_V1_TYPES[node.type] ?? node.type,
        },
      };
    }),
  };
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
  edges: ReadonlyArray<{ source: string; target: string }>;
};

/**
 * Host veto after pin compatibility (`GraphEditor.canConnect`): no connection
 * may close a loop. A linked pin is not refused: the canvas replaces the old
 * wire on a Particle output (`singleLink`) or on any input, which keeps the
 * spine linear.
 */
export function particleConnectionIsAllowed(
  graph: ConnectionGraph,
  connection: { source: string; target: string; sourceHandle: string; targetHandle: string },
): boolean {
  if (connection.source === connection.target) return false;
  // Adding source → target closes a loop when target already reaches source.
  // The wires it replaces never change the answer: the walk stops at source
  // before following source's old output wire, and the target input's old
  // wire only leads back to target.
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
