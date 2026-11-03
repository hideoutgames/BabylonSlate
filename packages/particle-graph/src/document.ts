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
} from "@haptic/core";
import {
  PARTICLE_CONDITION_TESTS,
  PARTICLE_OUTPUT_NODE_TYPE,
  particleAngleUnitPin,
  particleDegreesToRadians,
  particleNodeAngleUnit,
  particleNodeValueType,
  particleRadiansToDegrees,
  type ParticleAngleUnit,
  type ParticleConditionTest,
} from "./catalog";
import {
  defaultParticleGradientStops,
  particleGradientStops,
} from "./gradient";
import { resizeParticleValue, type ParticleNumericType } from "./types";
import { DEFAULT_PARTICLE_SPAWN, particleGraphSpawnEmitters, particleSpawnSettings } from "./spawn";

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
  /** Seconds the emitter runs when Loop is Once; Infinite ignores it. */
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

/** Longest parameter name, after trimming. */
export const PARTICLE_PARAMETER_NAME_MAX = 64;

/**
 * A value gameplay can set at runtime by name (Set Particle Float Parameter, Particle
 * System defaults, component overrides). Parameter nodes reference the stable `id`, so a
 * rename or a new default never rebuilds the emitter.
 */
export interface ParticleGraphParameter {
  id: string;
  /** Unique in the graph, case-sensitive, 1–64 characters after trimming. */
  name: string;
  type: ParticleNumericType;
  /** Sized to `type`. */
  defaultValue: number[];
}

export interface ParticleGraphDocument {
  schemaVersion: typeof PARTICLE_GRAPH_SCHEMA_VERSION;
  name: string;
  /** Particle-domain Material; required to render. */
  materialGuid: string | null;
  settings: ParticleGraphSettings;
  /** Declared runtime parameters, in authoring order. */
  parameters: ParticleGraphParameter[];
  nodes: ParticleGraphNode[];
  edges: ParticleGraphEdge[];
}

/** A trimmed parameter name, or null when it is empty or longer than `PARTICLE_PARAMETER_NAME_MAX`. */
export function normalizeParticleParameterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= PARTICLE_PARAMETER_NAME_MAX ? name : null;
}

/** Drops parameters without an id or a valid name, and later duplicates of either. */
export function normalizeParticleGraphParameters(value: unknown): ParticleGraphParameter[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const parameters: ParticleGraphParameter[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = normalizeParticleParameterName(record.name);
    if (!id || !name || ids.has(id) || names.has(name)) continue;
    const type = oneOf<ParticleNumericType>(record.type, ["float", "vec2", "vec3", "color"], "float");
    ids.add(id);
    names.add(name);
    parameters.push({ id, name, type, defaultValue: resizeParticleValue(numberArray(record.defaultValue), type) });
  }
  return parameters;
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
    case "particle.create":
      return { angleUnit: "radians" };
    case "shape.cone":
      return { emitFromSpawnPointOnly: false, angleUnit: "radians" };
    case "update.alignAngle":
      return { alignment: Math.PI / 2 };
    case "utility.localVariable":
      return { scope: "particle" };
    case "update.noise":
      return { textureGuid: null };
    case "shape.mesh":
      return { source: "ownerMesh", modelGuid: null, useMeshNormals: true, useMeshColor: false };
    case "input.parameter":
      return { parameterId: "", valueType: "float" };
    case "sprite.setup":
      return { ...DEFAULT_SPRITE_SHEET };
    case "trigger.spawn":
      return { ...DEFAULT_PARTICLE_SPAWN };
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
  const angleUnit = particleNodeAngleUnit(type, next);
  if (angleUnit) next.angleUnit = angleUnit;
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
    case "utility.localVariable":
      next.scope = next.scope === "loop" ? "loop" : "particle";
      break;
    case "update.noise":
      next.textureGuid = typeof next.textureGuid === "string" && next.textureGuid.trim() ? next.textureGuid : null;
      break;
    case "shape.mesh":
      next.source = next.source === "model" ? "model" : "ownerMesh";
      next.modelGuid = typeof next.modelGuid === "string" && next.modelGuid.trim() ? next.modelGuid : null;
      next.useMeshNormals = next.useMeshNormals !== false;
      next.useMeshColor = next.useMeshColor === true;
      break;
    case "sprite.setup":
      Object.assign(next, particleSpriteSheetSettings(next));
      break;
    case "trigger.spawn":
      Object.assign(next, particleSpawnSettings(next));
      break;
  }
  return next;
}

/** A Sprite Sheet node's settings: the cell grid, the cells particles use and how they animate. */
export interface ParticleSpriteSheetSettings {
  columns: number;
  rows: number;
  /** Cells are numbered from 0 at the top left, left to right, then row by row downwards. */
  startCell: number;
  /** At least Start Cell. */
  endCell: number;
  /** Cells per second of a particle's age for Animate Sprite Sheet; 0 holds the first cell. */
  framesPerSecond: number;
  loop: boolean;
  /** Each particle is born on a random cell from Start Cell to End Cell. */
  randomStartCell: boolean;
}

export const PARTICLE_SPRITE_SHEET_LIMITS = {
  columns: { min: 1, max: 64 },
  rows: { min: 1, max: 64 },
  framesPerSecond: { min: 0, max: 240 },
} as const;

const DEFAULT_SPRITE_SHEET: ParticleSpriteSheetSettings = {
  columns: 4,
  rows: 4,
  startCell: 0,
  endCell: 15,
  framesPerSecond: 30,
  loop: true,
  randomStartCell: false,
};

/** Normalized Sprite Sheet settings from a node's properties: whole cell counts and cells within the grid. */
export function particleSpriteSheetSettings(properties: Readonly<Record<string, unknown>>): ParticleSpriteSheetSettings {
  const whole = (value: unknown, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(asFinite(value, fallback))));
  const { columns: columnLimits, rows: rowLimits, framesPerSecond: rateLimits } = PARTICLE_SPRITE_SHEET_LIMITS;
  const columns = whole(properties.columns, DEFAULT_SPRITE_SHEET.columns, columnLimits.min, columnLimits.max);
  const rows = whole(properties.rows, DEFAULT_SPRITE_SHEET.rows, rowLimits.min, rowLimits.max);
  const last = columns * rows - 1;
  const startCell = whole(properties.startCell, 0, 0, last);
  return {
    columns,
    rows,
    startCell,
    endCell: whole(properties.endCell, last, startCell, last),
    framesPerSecond: Math.min(rateLimits.max, Math.max(rateLimits.min, asFinite(properties.framesPerSecond, DEFAULT_SPRITE_SHEET.framesPerSecond))),
    loop: properties.loop !== false,
    randomStartCell: properties.randomStartCell === true,
  };
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
    const sourcePinId = asString(record.sourcePinId, "");
    const targetNodeId = asString(record.targetNodeId, "");
    const targetPinId = asString(record.targetPinId, "");
    if (!sourceNodeId || !sourcePinId || !targetNodeId || !targetPinId) return [];
    return [
      {
        id: asString(record.id, `edge-${index}`),
        sourceNodeId,
        sourcePinId,
        targetNodeId,
        targetPinId,
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
  const parameters = normalizeParticleGraphParameters(record.parameters);
  return {
    schemaVersion: PARTICLE_GRAPH_SCHEMA_VERSION,
    name: asString(record.name, fallbackName),
    materialGuid: nullableGuid(record.materialGuid),
    settings: normalizeParticleGraphSettings(record.settings),
    parameters,
    nodes: syncParameterNodeTypes(withOutput(normalizeNodes(record.nodes)), parameters),
    edges: normalizeEdges(record.edges),
  };
}

/** A Parameter node's output takes its parameter's type; one without a parameter keeps its own. */
export function syncParameterNodeTypes(
  nodes: ParticleGraphNode[],
  parameters: readonly ParticleGraphParameter[],
): ParticleGraphNode[] {
  const types = new Map(parameters.map((parameter) => [parameter.id, parameter.type]));
  return nodes.map((node) => {
    if (node.type !== "input.parameter") return node;
    const type = types.get(String(node.properties.parameterId ?? ""));
    return type && node.properties.valueType !== type ? { ...node, properties: { ...node.properties, valueType: type } } : node;
  });
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
 * Create Particle → Sphere Shape → Apply Velocity → Update Color → Emitter
 * Output. Update Color multiplies Initial Color (Create Particle's Color) by a
 * Gradient over Normalized Age, so Create Particle's Color still shows. It
 * validates with only the Missing Material warning.
 */
export function createDefaultParticleGraphDocument(
  name = "Particle Graph",
): ParticleGraphDocument {
  return {
    schemaVersion: PARTICLE_GRAPH_SCHEMA_VERSION,
    name,
    materialGuid: null,
    settings: createDefaultParticleGraphSettings(),
    parameters: [],
    nodes: [
      node("create", "particle.create", 0, 0, {
        "default:lifetime": [1.5],
        "default:size": [0.3],
      }),
      node("shape", "shape.sphere", 450, 0, { "default:radius": [0.5] }),
      node("velocity", "update.basicPosition", 870, 0),
      node("initialColor", "input.contextual.initialColor", 450, 400),
      node("normalizedAge", "input.contextual.normalizedAge", 0, 580),
      node("gradient", "gradient.sample", 450, 580),
      node("multiply", "math.multiply", 870, 400),
      node("updateColor", "update.color", 1280, 0),
      node("output", PARTICLE_OUTPUT_NODE_TYPE, 1700, 0),
    ],
    edges: [
      edge("e-create-shape", "create", "out", "shape", "particle"),
      edge("e-shape-velocity", "shape", "out", "velocity", "particle"),
      edge("e-velocity-color", "velocity", "out", "updateColor", "particle"),
      edge("e-age-gradient", "normalizedAge", "out", "gradient", "ratio"),
      edge("e-initial-multiply", "initialColor", "out", "multiply", "a"),
      edge("e-gradient-multiply", "gradient", "out", "multiply", "b"),
      edge("e-multiply-color", "multiply", "out", "updateColor", "color"),
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

/**
 * Switch Create Particle's or Cone Shape's angle pin between radians and degrees,
 * converting its authored default so the emitter keeps its look.
 */
export function setParticleNodeAngleUnit(
  target: ParticleGraphNode,
  angleUnit: ParticleAngleUnit,
): ParticleGraphNode {
  const pinId = particleAngleUnitPin(target.type);
  const current = particleNodeAngleUnit(target.type, target.properties);
  if (!pinId || !current || current === angleUnit) return target;
  const properties: Record<string, unknown> = { ...target.properties, angleUnit };
  const key = `default:${pinId}`;
  const authored = numberArray(target.properties[key]);
  if (authored) {
    properties[key] = authored.map((value) =>
      angleUnit === "degrees" ? particleRadiansToDegrees(value) : particleDegreesToRadians(value),
    );
  }
  return { ...target, properties };
}

export interface ParticleGraphDependencies {
  materials: string[];
  /** Noise node Textures, sorted and unique. */
  textures: string[];
  /** Mesh Shape Models (Source Model), sorted and unique. */
  models: string[];
  /** Spawn Emitter emitters (Particle Emitters and Particle Graphs), sorted and unique. */
  emitters: string[];
  all: string[];
}

/** Header dependencies: the Material, every Noise node's Texture, Mesh Shape's Model and Spawn Emitter's emitter. */
export function particleGraphDependencies(
  doc: Pick<ParticleGraphDocument, "materialGuid"> & Partial<Pick<ParticleGraphDocument, "nodes">>,
): ParticleGraphDependencies {
  const materials = doc.materialGuid ? [doc.materialGuid] : [];
  const textures = particleGraphNoiseTextures(doc.nodes ?? []);
  const models = particleGraphMeshModels(doc.nodes ?? []);
  const emitters = particleGraphSpawnEmitters(doc.nodes ?? []);
  return { materials, textures, models, emitters, all: [...materials, ...textures, ...models, ...emitters] };
}

/** The Models the graph's Mesh Shapes read (Source Model), sorted and unique. */
export function particleGraphMeshModels(nodes: readonly ParticleGraphNode[]): string[] {
  const guids = new Set<string>();
  for (const node of nodes) {
    const guid = node.type === "shape.mesh" && node.properties.source === "model" ? node.properties.modelGuid : null;
    if (typeof guid === "string" && guid) guids.add(guid);
  }
  return [...guids].sort();
}

/** The Textures the graph's Noise nodes read, sorted and unique. */
export function particleGraphNoiseTextures(nodes: readonly ParticleGraphNode[]): string[] {
  const guids = new Set<string>();
  for (const node of nodes) {
    const guid = node.type === "update.noise" ? node.properties.textureGuid : null;
    if (typeof guid === "string" && guid) guids.add(guid);
  }
  return [...guids].sort();
}
