import {
  createDefaultParticleSystemPayload,
  normalizeParticleEmitterPayload,
  type ParticleEmitterPayload,
  type ParticleSpace,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
import {
  createDefaultParticleGraphDocument,
  newParticleNodeProperties,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import { newAssetFileName, type CreatableAssetType } from "../content-browser-helpers";
import {
  actor,
  comp,
  requireRef,
  tf,
  type FeatureTestContext,
  type Vec3,
} from "./context";
import { stressPoint } from "./layout";
import { FEATURE_TEST_MATERIAL_NAMES, featureTestMaterialAssetGuid } from "./materials";

/** Folder under `assets/FeatureTest/` for every Particle Emitter, Particle Graph and Particle System. */
export const FEATURE_TEST_PARTICLES_FOLDER = "Particles";

/** Asset names, so sibling FeatureTest modules can look the assets up by path. */
export const FEATURE_TEST_PARTICLE_NAMES = {
  fountainEmitter: "FT_FxFountainEmitter",
  sparksEmitter: "FT_FxSparksEmitter",
  smokeEmitter: "FT_FxSmokeEmitter",
  stressEmitter: "FT_FxStressEmitter",
  glowGraph: "FT_FxGlowGraph",
  /** Mixes the Basic fountain emitter and the CPU Particle Graph in one System. */
  showcase: "FT_FxShowcase",
  sparks: "FT_FxSparks",
  smoke: "FT_FxSmoke",
  /** Heavy GPU workload, placed only in `FT_Stress`. */
  stress: "FT_FxStress",
} as const;

const NAMES = FEATURE_TEST_PARTICLE_NAMES;
const FOLDER = FEATURE_TEST_PARTICLES_FOLDER;

/**
 * Stress knobs: each `FT_Stress` actor holds about min(capacity, rate × lifetime)
 * = 4000 live GPU particles (the CPU fallback caps at 512 per emitter).
 */
const STRESS_CAPACITY = 4096;
const STRESS_RATE = 2000;
const STRESS_LIFETIME = 2;
/** Region-local (x, z) of each stress actor; one System per actor. */
const STRESS_GRID: ReadonlyArray<readonly [number, number]> = [
  [-6, -8],
  [6, -8],
  [-6, 8],
  [6, 8],
];

/** Guid of a particle asset this module created. */
export function featureTestParticleAssetGuid(
  ctx: FeatureTestContext,
  type: Extract<CreatableAssetType, "ParticleEmitter" | "ParticleGraph" | "ParticleSystem">,
  name: string,
): string {
  const asset = ctx.registry.getByPath(ctx.storagePath(FOLDER, newAssetFileName(type, name)));
  return requireRef(asset?.header.guid, `${type} ${name}`);
}

/**
 * Particle Emitters (Basic module stacks on GPU, one per blend style), a CPU
 * Particle Graph and Particle Systems: one mixing both emitter kinds, two
 * single-emitter Systems and the dedicated stress System. Every emitter uses a
 * particle-domain Material (the smoke uses a particle-domain Material Instance).
 */
export async function buildFeatureTestParticles(ctx: FeatureTestContext): Promise<void> {
  const soft = requireRef(ctx.assets.materials.particle, "the particle Material");
  const glow = requireRef(ctx.assets.materials.particleAdditive, "the additive particle Material");
  const smokeMaterial = featureTestMaterialAssetGuid(ctx, "MaterialInstance", FEATURE_TEST_MATERIAL_NAMES.particleSmoke);

  const fountain = await saveEmitter(ctx, NAMES.fountainEmitter, fountainEmitter(soft));
  const sparks = await saveEmitter(ctx, NAMES.sparksEmitter, sparksEmitter(glow));
  const smoke = await saveEmitter(ctx, NAMES.smokeEmitter, smokeEmitter(smokeMaterial));
  const stress = await saveEmitter(ctx, NAMES.stressEmitter, stressEmitter(glow));
  const graph = (
    await ctx.createAsset("ParticleGraph", FOLDER, NAMES.glowGraph, {
      payload: payload(glowGraph(NAMES.glowGraph, glow)),
    })
  ).guid;

  await saveSystem(ctx, NAMES.showcase, [fountain, graph], "world");
  await saveSystem(ctx, NAMES.sparks, [sparks], "world");
  await saveSystem(ctx, NAMES.smoke, [smoke], "local");
  await saveSystem(ctx, NAMES.stress, [stress], "world");
}

/**
 * `Particles` zone: floor and three Particle Component actors (mixed fountain
 * and graph, spark bursts, rising smoke). The stress System goes only into
 * `FT_Stress` (`particles` region), one actor per grid cell.
 */
export async function placeFeatureTestParticles(ctx: FeatureTestContext): Promise<void> {
  const zone = ctx.zone("particles");
  zone.floor();
  const system = (name: string) => featureTestParticleAssetGuid(ctx, "ParticleSystem", name);
  const emitterActor = (id: string, name: string, systemGuid: string, position: Vec3) =>
    actor(`ft-fx-${id}`, name, tf(position), [
      comp(`ft-fx-${id}-particles`, "ParticleComponent", { particleSystemGuid: systemGuid, playOnStart: true }),
    ]);

  ctx.addActor(emitterActor("showcase", "Fountain And Glow Graph", system(NAMES.showcase), zone.at(-7, 0.1, -2)), {
    zone: "particles",
  });
  ctx.addActor(emitterActor("sparks", "Spark Bursts", system(NAMES.sparks), zone.at(0, 1.2, -2)), { zone: "particles" });
  ctx.addActor(emitterActor("smoke", "Rising Smoke", system(NAMES.smoke), zone.at(7, 0.1, -2)), { zone: "particles" });

  const stress = system(NAMES.stress);
  STRESS_GRID.forEach(([x, z], index) => {
    ctx.addActor(
      emitterActor(`stress-${index + 1}`, `Particle Stress ${index + 1}`, stress, stressPoint("particles", [x, 2, z])),
      { scene: ctx.stressScene },
    );
  });
}

// ---------------------------------------------------------------------------
// Asset writers

async function saveEmitter(ctx: FeatureTestContext, name: string, emitter: ParticleEmitterPayload): Promise<string> {
  return (await ctx.createAsset("ParticleEmitter", FOLDER, name, { payload: payload(emitter) })).guid;
}

async function saveSystem(
  ctx: FeatureTestContext,
  name: string,
  emitterGuids: string[],
  space: ParticleSpace,
): Promise<string> {
  const system: ParticleSystemPayload = { ...createDefaultParticleSystemPayload(), emitterGuids, space };
  return (await ctx.createAsset("ParticleSystem", FOLDER, name, { payload: payload(system) })).guid;
}

function payload(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Basic emitters (module stacks; normalized so every stored field is valid)

/** Alpha-blended (Normal) water fountain: cone, bursts, size and color curves, rotation, drag, gravity. */
function fountainEmitter(materialGuid: string): ParticleEmitterPayload {
  return normalizeParticleEmitterPayload({
    emitter: { loop: "infinite", duration: 3, prewarm: 2, capacity: 512 },
    spawn: {
      rate: { mode: "constant", value: 60 },
      bursts: { enabled: true, entries: [{ time: 0, count: 48, cycles: 0, interval: 1.5 }] },
    },
    shape: {
      kind: "cone",
      radius: 0.15,
      angle: 0.5,
      radiusRange: 1,
      heightRange: 1,
      emitFromSpawnPointOnly: false,
      direction: { mode: "radial", randomizer: 0.1 },
    },
    initialize: {
      lifetime: { mode: "constant", value: 2 },
      speed: { mode: "range", min: 4, max: 6 },
      size: { mode: "curve", keys: [{ t: 0, value: 0.2 }, { t: 0.3, value: 0.45 }, { t: 1, value: 0.1 }] },
      color: {
        mode: "curve",
        keys: [
          { t: 0, color: [0.55, 0.85, 1, 1] },
          { t: 0.6, color: [0.3, 0.55, 1, 0.8] },
          { t: 1, color: [0.2, 0.3, 0.9, 0] },
        ],
      },
      rotation: { enabled: true, start: { mode: "range", min: 0, max: 6.28 }, speed: { mode: "constant", value: 2 } },
    },
    overLife: { drag: { enabled: true, amount: { mode: "constant", value: 0.05 } } },
    forces: { gravity: { enabled: true, acceleration: [0, -6, 0] } },
    render: { materialGuid, blendMode: "standard", billboard: "all" },
  });
}

/** Additive stretched sparks: two repeating bursts, a rate curve, velocity curve and speed limit. */
function sparksEmitter(materialGuid: string): ParticleEmitterPayload {
  return normalizeParticleEmitterPayload({
    emitter: { loop: "infinite", duration: 2, prewarm: 0, capacity: 512 },
    spawn: {
      rate: { mode: "curve", keys: [{ t: 0, value: 40 }, { t: 0.5, value: 5 }, { t: 1, value: 40 }] },
      bursts: {
        enabled: true,
        entries: [
          { time: 0, count: 96, cycles: 0, interval: 1 },
          { time: 0.5, count: 32, cycles: 0, interval: 1 },
        ],
      },
    },
    shape: { kind: "sphere", radius: 0.2, radiusRange: 0.5, direction: { mode: "radial", randomizer: 0.3 } },
    initialize: {
      lifetime: { mode: "range", min: 0.6, max: 1.2 },
      speed: { mode: "range", min: 4, max: 8 },
      size: { mode: "range", min: 0.08, max: 0.16 },
      color: {
        mode: "curve",
        keys: [
          { t: 0, color: [1, 0.9, 0.5, 1] },
          { t: 0.4, color: [1, 0.5, 0.1, 1] },
          { t: 1, color: [0.6, 0.1, 0, 0] },
        ],
      },
      scale: { enabled: true, x: { mode: "constant", value: 1 }, y: { mode: "range", min: 2, max: 3 } },
    },
    overLife: {
      velocity: { enabled: true, multiplier: { mode: "curve", keys: [{ t: 0, value: 1 }, { t: 1, value: 0.3 }] } },
      speedLimit: { enabled: true, limit: { mode: "constant", value: 6 }, damping: 0.3 },
    },
    forces: { gravity: { enabled: true, acceleration: [0, -9.81, 0] } },
    render: { materialGuid, blendMode: "additive", billboard: "stretched" },
  });
}

/** Alpha-blended Y-billboard smoke: directed cylinder, growing size, fade in/out, spin, drag and wind. */
function smokeEmitter(materialGuid: string): ParticleEmitterPayload {
  return normalizeParticleEmitterPayload({
    emitter: { loop: "infinite", duration: 4, prewarm: 4, capacity: 256 },
    spawn: { rate: { mode: "constant", value: 18 } },
    shape: {
      kind: "cylinder",
      radius: 0.6,
      height: 0.2,
      radiusRange: 1,
      direction: { mode: "directed", direction1: [-0.15, 1, -0.15], direction2: [0.15, 1, 0.15] },
    },
    initialize: {
      lifetime: { mode: "range", min: 3, max: 4 },
      speed: { mode: "range", min: 0.6, max: 1 },
      size: { mode: "curve", keys: [{ t: 0, value: 0.6 }, { t: 1, value: 2.2 }] },
      color: {
        mode: "curve",
        keys: [
          { t: 0, color: [0.55, 0.55, 0.6, 0] },
          { t: 0.15, color: [0.6, 0.6, 0.65, 0.6] },
          { t: 1, color: [0.75, 0.75, 0.8, 0] },
        ],
      },
      rotation: {
        enabled: true,
        start: { mode: "range", min: 0, max: 6.28 },
        speed: { mode: "range", min: -0.4, max: 0.4 },
      },
    },
    overLife: { drag: { enabled: true, amount: { mode: "curve", keys: [{ t: 0, value: 0 }, { t: 1, value: 0.2 }] } } },
    forces: { gravity: { enabled: true, acceleration: [0.3, 0.2, 0] } },
    render: { materialGuid, blendMode: "standard", billboard: "y" },
  });
}

/** Deterministic GPU load: constant rate and lifetime, max capacity, prewarmed to steady state. */
function stressEmitter(materialGuid: string): ParticleEmitterPayload {
  return normalizeParticleEmitterPayload({
    emitter: { loop: "infinite", duration: 2, prewarm: STRESS_LIFETIME, capacity: STRESS_CAPACITY },
    spawn: { rate: { mode: "constant", value: STRESS_RATE } },
    shape: { kind: "sphere", radius: 2, radiusRange: 1, direction: { mode: "radial", randomizer: 0 } },
    initialize: {
      lifetime: { mode: "constant", value: STRESS_LIFETIME },
      speed: { mode: "constant", value: 0.5 },
      size: { mode: "constant", value: 0.2 },
      color: { mode: "constant", color: [0.3, 0.6, 1, 1] },
    },
    render: { materialGuid, blendMode: "additive", billboard: "all" },
  });
}

// ---------------------------------------------------------------------------
// Particle Graph (CPU node particles)

/**
 * Create Particle (Random size per particle) → Sphere Shape → Apply Velocity
 * → Gravity (gentle lift) → Update Color (Initial Color × Gradient over
 * Normalized Age) → Emitter Output at 90/s. One Particle output feeds one node.
 */
function glowGraph(name: string, materialGuid: string): ParticleGraphDocument {
  const graph = createDefaultParticleGraphDocument(name);
  graph.materialGuid = materialGuid;
  graph.settings = { capacity: 512, loop: "infinite", duration: 4, prewarm: 1, blendMode: "additive", billboard: "all" };
  const edit = (id: string, properties: Record<string, unknown>, x?: number) => {
    const found = graph.nodes.find((entry) => entry.id === id);
    if (!found) throw new Error(`FeatureTest Particle Graph has no "${id}" node.`);
    Object.assign(found.properties, properties);
    if (x !== undefined) found.position = { ...found.position, x };
  };
  edit("create", { "default:emitPower": [2.5], "default:lifetime": [1.8] });
  edit("shape", { "default:radius": [0.6] });
  edit("gradient", {
    stops: [
      { position: 0, value: [0.5, 0.9, 1, 1] },
      { position: 0.5, value: [0.7, 0.5, 1, 0.9] },
      { position: 1, value: [0.4, 0.1, 0.8, 0] },
    ],
  });
  edit("updateColor", {}, 1700);
  edit("output", { "default:emitRate": [90] }, 2120);
  graph.nodes.push(
    {
      id: "gravity",
      type: "force.gravity",
      position: { x: 1280, y: 0 },
      properties: { ...newParticleNodeProperties("force.gravity"), "default:acceleration": [0, 1.5, 0] },
    },
    {
      id: "sizeRandom",
      type: "random.range",
      position: { x: -450, y: 300 },
      properties: { ...newParticleNodeProperties("random.range"), "default:min": [0.12], "default:max": [0.35] },
    },
  );
  graph.edges = graph.edges.filter((entry) => entry.id !== "e-velocity-color");
  graph.edges.push(
    { id: "e-velocity-gravity", sourceNodeId: "velocity", sourcePinId: "out", targetNodeId: "gravity", targetPinId: "particle" },
    { id: "e-gravity-color", sourceNodeId: "gravity", sourcePinId: "out", targetNodeId: "updateColor", targetPinId: "particle" },
    { id: "e-size-create", sourceNodeId: "sizeRandom", sourcePinId: "out", targetNodeId: "create", targetPinId: "size" },
  );
  return graph;
}
