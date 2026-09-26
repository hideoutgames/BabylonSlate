import {
  PARTICLE_BILLBOARD_MODE_IDS,
  PARTICLE_BLEND_MODE_IDS,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_PREWARM_MAX_SECONDS,
  type ParticleBillboardMode,
  type ParticleBlendMode,
  type ParticleLoopMode,
} from "@babylonslate/core";
import {
  PARTICLE_CONDITION_TESTS,
  PARTICLE_OUTPUT_NODE_TYPE,
  particleNodeValueType,
  type ParticleConditionTest,
} from "./catalog";
import {
  defaultParticleGradientStops,
  particleGradientStops,
} from "./gradient";
import { resizeParticleValue, type ParticleNumericType } from "./types";

/** Payload field; never a top-level `version` (the project service strips it). */
export const PARTICLE_GRAPH_SCHEMA_VERSION = 1 as const;

export interface ParticleGraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

export interface ParticleGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

/**
 * Emitter settings, named like the Basic emitter's Emitter and Render stages.
 * There is no Space (the Particle System owns it) and no backend: Particle
 * Graphs always simulate on the CPU, and capacity above 512 only warns.
 */
export interface ParticleGraphSettings {
  /** 16–4096. */
  capacity: number;
  loop: ParticleLoopMode;
  /** Seconds: loop length when infinite, run length when once. */
  duration: number;
  /** Seconds simulated before the first frame; infinite loops only. */
  prewarm: number;
  blendMode: ParticleBlendMode;
  billboard: ParticleBillboardMode;
}

export const PARTICLE_GRAPH_LIMITS = {
  capacity: { min: PARTICLE_CAPACITY_MIN, max: PARTICLE_CAPACITY_MAX },
  duration: { min: 0.05, max: 600 },
  prewarm: { min: 0, max: PARTICLE_PREWARM_MAX_SECONDS },
} as const;

export interface ParticleGraphDocument {
  schemaVersion: typeof PARTICLE_GRAPH_SCHEMA_VERSION;
  name: string;
  /** Particle-domain Material; required to render. */
  materialGuid: string | null;
  settings: ParticleGraphSettings;
  nodes: ParticleGraphNode[];
  edges: ParticleGraphEdge[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function asFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bounded(
  value: unknown,
  fallback: number,
  limits: { min: number; max: number },
): number {
  return Math.min(limits.max, Math.max(limits.min, asFinite(value, fallback)));
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((component) =>
    typeof component === "number" && Number.isFinite(component) ? component : 0,
  );
}

export function createDefaultParticleGraphSettings(): ParticleGraphSettings {
  return {
    capacity: PARTICLE_CAPACITY_DEFAULT,
    loop: "infinite",
    duration: 2,
    prewarm: 0,
    blendMode: "additive",
    billboard: "all",
  };
}

export function normalizeParticleGraphSettings(value: unknown): ParticleGraphSettings {
  const record = asRecord(value);
  const defaults = createDefaultParticleGraphSettings();
  return {
    capacity: Math.round(bounded(record.capacity, defaults.capacity, PARTICLE_GRAPH_LIMITS.capacity)),
    loop: record.loop === "once" ? "once" : "infinite",
    duration: bounded(record.duration, defaults.duration, PARTICLE_GRAPH_LIMITS.duration),
    prewarm: bounded(record.prewarm, defaults.prewarm, PARTICLE_GRAPH_LIMITS.prewarm),
    blendMode: oneOf(record.blendMode, PARTICLE_BLEND_MODE_IDS, defaults.blendMode),
    billboard: oneOf(record.billboard, PARTICLE_BILLBOARD_MODE_IDS, defaults.billboard),
  };
}

const CONDITION_TEST_IDS = PARTICLE_CONDITION_TESTS.map((test) => test.id);

/** Properties a new node of `type` starts with (Add Node and the default graph). */
export function newParticleNodeProperties(type: string): Record<string, unknown> {
  switch (type) {
    case "random.range":
      return { valueType: "float", lock: "perParticle" };
    case "gradient.sample":
      return { valueType: "color", stops: defaultParticleGradientStops("color") };
    case "logic.condition":
      return { test: "lessThan", epsilon: 0 };
    case "const.float":
      return { value: [0] };
    case "const.vec2":
      return { value: [0, 0] };
    case "const.vec3":
      return { value: [0, 0, 0] };
    case "const.color":
      return { value: [1, 1, 1, 1] };
    case "shape.sphere":
      return { hemisphere: false };
    case "shape.cone":
      return { emitFromSpawnPointOnly: false };
    case "update.alignAngle":
      return { alignment: Math.PI / 2 };
    default:
      return {};
  }
}

const CONSTANT_TYPES: Readonly<Record<string, ParticleNumericType>> = {
  "const.float": "float",
  "const.vec2": "vec2",
  "const.vec3": "vec3",
  "const.color": "color",
};

/**
 * Sanitize the properties a node type reads. Unknown keys are kept; every
 * `default:<pinId>` becomes a finite number array.
 */
export function normalizeParticleNodeProperties(
  type: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith("default:")) {
      next[key] = value;
      continue;
    }
    const numbers = numberArray(value);
    if (numbers) next[key] = numbers;
  }
  const constantType = CONSTANT_TYPES[type];
  if (constantType) {
    const fallback = newParticleNodeProperties(type).value as number[];
    const value = numberArray(next.value);
    next.value = resizeParticleValue(value && value.length > 0 ? value : fallback, constantType);
  }
  const valueType = particleNodeValueType(type, next);
  if (valueType) next.valueType = valueType;
  switch (type) {
    case "random.range":
      next.lock = next.lock === "everyRead" ? "everyRead" : "perParticle";
      break;
    case "gradient.sample":
      next.stops = particleGradientStops(next.stops, valueType ?? "color");
      break;
    case "logic.condition":
      next.test = oneOf<ParticleConditionTest>(next.test, CONDITION_TEST_IDS, "lessThan");
      next.epsilon = Math.max(0, asFinite(next.epsilon, 0));
      break;
    case "shape.sphere":
      next.hemisphere = next.hemisphere === true;
      break;
    case "shape.cone":
      next.emitFromSpawnPointOnly = next.emitFromSpawnPointOnly === true;
      break;
    case "update.alignAngle":
      next.alignment = asFinite(next.alignment, Math.PI / 2);
      break;
  }
  return next;
}

function normalizeNodes(value: unknown): ParticleGraphNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const type = asString(record.type, "");
    if (!type) return [];
    const position = asRecord(record.position);
    return [
      {
        id: asString(record.id, `node-${index}`),
        type,
        position: { x: asFinite(position.x, 0), y: asFinite(position.y, 0) },
        properties: normalizeParticleNodeProperties(type, asRecord(record.properties)),
      },
    ];
  });
}

function normalizeEdges(value: unknown): ParticleGraphEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const sourceNodeId = asString(record.sourceNodeId, "");
    const targetNodeId = asString(record.targetNodeId, "");
    if (!sourceNodeId || !targetNodeId) return [];
    return [
      {
        id: asString(record.id, `edge-${index}`),
        sourceNodeId,
        sourcePinId: asString(record.sourcePinId, "out"),
        targetNodeId,
        targetPinId: asString(record.targetPinId, "in"),
      },
    ];
  });
}

/** A graph can never lack its Emitter Output. */
function withOutput(nodes: ParticleGraphNode[]): ParticleGraphNode[] {
  if (nodes.some((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE)) return nodes;
  const ids = new Set(nodes.map((node) => node.id));
  let id = "output";
  for (let suffix = 2; ids.has(id); suffix++) id = `output-${suffix}`;
  const x = nodes.length > 0 ? Math.max(...nodes.map((node) => node.position.x)) + 400 : 0;
  return [
    ...nodes,
    { id, type: PARTICLE_OUTPUT_NODE_TYPE, position: { x, y: 0 }, properties: {} },
  ];
}

export function normalizeParticleGraphDocument(
  value: unknown,
  fallbackName = "Particle Graph",
): ParticleGraphDocument {
  const record = asRecord(value);
  return {
    schemaVersion: PARTICLE_GRAPH_SCHEMA_VERSION,
    name: asString(record.name, fallbackName),
    materialGuid: nullableGuid(record.materialGuid),
    settings: normalizeParticleGraphSettings(record.settings),
    nodes: withOutput(normalizeNodes(record.nodes)),
    edges: normalizeEdges(record.edges),
  };
}

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  properties: Record<string, unknown> = {},
): ParticleGraphNode {
  return {
    id,
    type,
    position: { x, y },
    properties: { ...newParticleNodeProperties(type), ...properties },
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
): ParticleGraphEdge {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

/**
 * Create Particle → Sphere Shape → Apply Velocity → Update Color (Gradient over
 * Normalized Age) → Emitter Output. It validates with only the Missing
 * Material warning.
 */
export function createDefaultParticleGraphDocument(
  name = "Particle Graph",
): ParticleGraphDocument {
  return {
    schemaVersion: PARTICLE_GRAPH_SCHEMA_VERSION,
    name,
    materialGuid: null,
    settings: createDefaultParticleGraphSettings(),
    nodes: [
      node("create", "particle.create", 0, 0, {
        "default:lifetime": [1.5],
        "default:size": [0.3],
      }),
      node("shape", "shape.sphere", 450, 0, { "default:radius": [0.5] }),
      node("velocity", "update.basicPosition", 870, 0),
      node("normalizedAge", "input.contextual.normalizedAge", 450, 400),
      node("gradient", "gradient.sample", 850, 400),
      node("updateColor", "update.color", 1280, 0),
      node("output", PARTICLE_OUTPUT_NODE_TYPE, 1680, 0),
    ],
    edges: [
      edge("e-create-shape", "create", "out", "shape", "particle"),
      edge("e-shape-velocity", "shape", "out", "velocity", "particle"),
      edge("e-velocity-color", "velocity", "out", "updateColor", "particle"),
      edge("e-age-gradient", "normalizedAge", "out", "gradient", "ratio"),
      edge("e-gradient-color", "gradient", "out", "updateColor", "color"),
      edge("e-color-output", "updateColor", "out", "output", "particle"),
    ],
  };
}

/**
 * Change a Random or Gradient node's `valueType`, resizing its stops and
 * authored Min / Max. Edges that no longer fit stay and are reported.
 */
export function setParticleNodeValueType(
  target: ParticleGraphNode,
  valueType: ParticleNumericType,
): ParticleGraphNode {
  if (!particleNodeValueType(target.type, target.properties)) return target;
  const properties: Record<string, unknown> = { ...target.properties, valueType };
  if (target.type === "gradient.sample") {
    const current = particleNodeValueType(target.type, target.properties) ?? "color";
    const stops = particleGradientStops(target.properties.stops, current);
    properties.stops = stops.map((stop) => ({
      position: stop.position,
      value: resizeParticleValue(stop.value, valueType),
    }));
  }
  for (const pinId of ["min", "max"]) {
    const key = `default:${pinId}`;
    const authored = numberArray(target.properties[key]);
    if (authored && target.type === "random.range") {
      properties[key] = resizeParticleValue(authored, valueType);
    }
  }
  return { ...target, properties };
}

export interface ParticleGraphDependencies {
  materials: string[];
  all: string[];
}

/** Header dependencies: the Material only. */
export function particleGraphDependencies(
  doc: Pick<ParticleGraphDocument, "materialGuid">,
): ParticleGraphDependencies {
  const materials = doc.materialGuid ? [doc.materialGuid] : [];
  return { materials, all: [...materials] };
}
