import type { ParticlePinDefinition } from "./catalog";
import {
  numberArray,
  type ParticleGraphEdge,
  type ParticleGraphNode,
} from "./document";
import { createParticleTypeResolver } from "./resolve";
import { resizeParticleValue, type ParticleNumericType } from "./types";

export function particlePinDefaultPropertyKey(pinId: string): string {
  return `default:${pinId}`;
}

/** Authored value of an unconnected pin (`default:<pinId>`), if any. */
export function readParticlePinDefault(
  properties: Record<string, unknown>,
  pinId: string,
): number[] | undefined {
  return numberArray(properties[particlePinDefaultPropertyKey(pinId)]);
}

/** Authored value, else the catalog default, else undefined (pin left unconnected). */
export function resolveParticlePinDefault(
  node: Pick<ParticleGraphNode, "properties">,
  pin: Pick<ParticlePinDefinition, "id" | "defaultValue">,
): number[] | undefined {
  return readParticlePinDefault(node.properties, pin.id) ?? pin.defaultValue;
}

/** Clamp each component to the pin's range. */
export function clampParticlePinValue(
  value: readonly number[],
  pin: Pick<ParticlePinDefinition, "min" | "max">,
): number[] {
  return value.map((component) =>
    Math.min(pin.max ?? Infinity, Math.max(pin.min ?? -Infinity, component)),
  );
}

export interface ParticlePinDefault {
  pinId: string;
  name: string;
  type: ParticleNumericType;
  value: number[];
  min?: number;
  max?: number;
  description?: string;
}

/**
 * Details rows for one node's unconnected numeric inputs that have a value:
 * sized to the resolved type (a generic group wired to Vector 3 shows three
 * components). Particle pins never appear; shape direction pins appear once
 * authored.
 */
export function listUnconnectedParticlePinDefaults(
  graph: { nodes: readonly ParticleGraphNode[]; edges: readonly ParticleGraphEdge[] },
  nodeId: string,
): ParticlePinDefault[] {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) return [];
  const resolver = createParticleTypeResolver(graph);
  const definition = resolver.definitionOf(nodeId);
  if (!definition) return [];
  const connected = new Set(
    graph.edges.filter((edge) => edge.targetNodeId === nodeId).map((edge) => edge.targetPinId),
  );
  const rows: ParticlePinDefault[] = [];
  for (const pin of definition.inputs) {
    if (connected.has(pin.id) || pin.type.kind === "particle") continue;
    const value = resolveParticlePinDefault(node, pin);
    if (!value) continue;
    const resolved = resolver.inputType(nodeId, pin.id);
    const type: ParticleNumericType =
      resolved && resolved !== "particle"
        ? resolved
        : pin.type.kind === "generic"
          ? (pin.type.fallback ?? "float")
          : "float";
    rows.push({
      pinId: pin.id,
      name: pin.name,
      type,
      value: resizeParticleValue(value, type),
      ...(pin.min !== undefined ? { min: pin.min } : {}),
      ...(pin.max !== undefined ? { max: pin.max } : {}),
      ...(pin.description ? { description: pin.description } : {}),
    });
  }
  return rows;
}
