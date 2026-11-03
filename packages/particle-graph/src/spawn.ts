/**
 * Spawn Emitter (`trigger.spawn`): plays another emitter asset at a particle's position. Its
 * settings, the emitters a graph spawns, and the Inspector's Condition presets.
 */
import type { ParticleGraphDocument, ParticleGraphEdge, ParticleGraphNode } from "./document";

/** Spawn Emitter's settings. */
export interface ParticleSpawnSettings {
  /** A Particle Emitter or Particle Graph asset; null spawns nothing. */
  emitterGuid: string | null;
  /** Spawned emitters of this node playing at once. */
  limit: number;
  /** Simulated seconds between two spawns of this node. */
  minInterval: number;
  /** A spawned emitter keeps moving with the particle's velocity at the moment it fired. */
  inheritVelocity: boolean;
}

export const PARTICLE_SPAWN_LIMITS = {
  limit: { min: 1, max: 64 },
  minInterval: { min: 0, max: 60 },
  /** Spawned emitters spawn again at most this many levels below the playing effect. */
  depth: 2,
} as const;

export const DEFAULT_PARTICLE_SPAWN: ParticleSpawnSettings = {
  emitterGuid: null,
  limit: 8,
  minInterval: 0,
  inheritVelocity: false,
};

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Normalized Spawn Emitter settings from a node's properties. */
export function particleSpawnSettings(properties: Readonly<Record<string, unknown>>): ParticleSpawnSettings {
  const { limit, minInterval } = PARTICLE_SPAWN_LIMITS;
  return {
    emitterGuid: typeof properties.emitterGuid === "string" && properties.emitterGuid.trim() ? properties.emitterGuid : null,
    limit: Math.min(limit.max, Math.max(limit.min, Math.round(finite(properties.limit, DEFAULT_PARTICLE_SPAWN.limit)))),
    minInterval: Math.min(minInterval.max, Math.max(minInterval.min, finite(properties.minInterval, 0))),
    inheritVelocity: properties.inheritVelocity === true,
  };
}

/** The emitters the graph's Spawn Emitter nodes play, sorted and unique. */
export function particleGraphSpawnEmitters(nodes: readonly ParticleGraphNode[]): string[] {
  const guids = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "trigger.spawn") continue;
    const guid = particleSpawnSettings(node.properties).emitterGuid;
    if (guid) guids.add(guid);
  }
  return [...guids].sort();
}

export type ParticleSpawnPreset = "death" | "spawn";

export const PARTICLE_SPAWN_PRESETS: readonly { id: ParticleSpawnPreset; label: string; description: string }[] = [
  { id: "death", label: "On Death", description: "Fires once for each particle, in its last update (Normalized Age reaches 1)." },
  { id: "spawn", label: "On Spawn", description: "Fires once for each particle, in its first update (Age is at most Delta Time)." },
];

/**
 * `doc` with Spawn Emitter `nodeId`'s Condition driven by a preset: a Condition node comparing
 * Normalized Age ≥ 1 (On Death) or Age ≤ Delta Time (On Spawn), placed to the left of the node.
 * Whatever fed Condition before is disconnected; the preset's nodes get ids not in the graph.
 */
export function withParticleSpawnPreset(doc: ParticleGraphDocument, nodeId: string, preset: ParticleSpawnPreset): ParticleGraphDocument {
  const target = doc.nodes.find((node) => node.id === nodeId);
  if (!target || target.type !== "trigger.spawn") return doc;
  const taken = new Set([...doc.nodes.map((node) => node.id), ...doc.edges.map((edge) => edge.id)]);
  const fresh = (base: string) => {
    let id = `${nodeId}-${base}`;
    for (let index = 2; taken.has(id); index += 1) id = `${nodeId}-${base}-${index}`;
    taken.add(id);
    return id;
  };
  const { x, y } = target.position;
  const test = fresh("when");
  const nodes: ParticleGraphNode[] = [
    { id: test, type: "logic.condition", position: { x: x - 280, y: y + 180 },
      properties: preset === "death"
        ? { test: "greaterOrEqual", epsilon: 0, "default:b": [1], "default:whenTrue": [1], "default:whenFalse": [0] }
        : { test: "lessOrEqual", epsilon: 0, "default:whenTrue": [1], "default:whenFalse": [0] } },
  ];
  const edges: ParticleGraphEdge[] = [
    { id: fresh("condition"), sourceNodeId: test, sourcePinId: "out", targetNodeId: nodeId, targetPinId: "condition" },
  ];
  if (preset === "death") {
    const age = fresh("normalizedAge");
    nodes.push({ id: age, type: "input.contextual.normalizedAge", position: { x: x - 560, y: y + 180 }, properties: {} });
    edges.push({ id: fresh("a"), sourceNodeId: age, sourcePinId: "out", targetNodeId: test, targetPinId: "a" });
  } else {
    const age = fresh("age");
    const delta = fresh("deltaTime");
    nodes.push(
      { id: age, type: "input.contextual.age", position: { x: x - 560, y: y + 140 }, properties: {} },
      { id: delta, type: "input.system.deltaTime", position: { x: x - 560, y: y + 240 }, properties: {} },
    );
    edges.push(
      { id: fresh("a"), sourceNodeId: age, sourcePinId: "out", targetNodeId: test, targetPinId: "a" },
      { id: fresh("b"), sourceNodeId: delta, sourcePinId: "out", targetNodeId: test, targetPinId: "b" },
    );
  }
  return {
    ...doc,
    nodes: [...doc.nodes, ...nodes],
    edges: [...doc.edges.filter((edge) => !(edge.targetNodeId === nodeId && edge.targetPinId === "condition")), ...edges],
  };
}
