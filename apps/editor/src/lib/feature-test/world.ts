import {
  createSeededRng,
  landscapeHeightAt,
  normalizeWaterBody,
  parseLandscapeProperties,
  waterRiverCentreline,
  type FoliageBatch,
  type FoliageGroup,
  type LandscapeProperties,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
  type WaterDefinition,
  type WaterRiverSample,
  type WaterStyle,
  type WaterStylizedLook,
} from "@babylonslate/core";
import { newAssetFileName } from "../content-browser-helpers";
import { actor, comp, meshComp, requireRef, tf, type FeatureTestContext, type Vec3 } from "./context";
import type { FeatureTestHolidayModel } from "./engine-content-files";
import { FEATURE_TEST_SEA_LEVEL, stressPoint } from "./layout";

/**
 * `Landscape And Water` zone: an island Landscape (painted layers, collision,
 * a river channel and a lake basin) with Foliage, every water body kind, a
 * Water Removal dry dock, buoyant presents, Splines and Cables. The dense
 * Foliage workload lives only in `FT_Stress` (`foliage` region).
 *
 * Landscape-local coordinates (`land(x, y, z)`) share the landscape actor's
 * origin, so river points, the lake, splines and foliage reuse its height data.
 */

/** Folder under `assets/FeatureTest/` for the Water assets. */
export const FEATURE_TEST_WORLD_FOLDER = "World";

/** Water assets, one per shading path. */
export const FEATURE_TEST_WORLD_WATER = {
  /** Global Water Volume: Realistic, classic swell. */
  sea: "FT_WorldSea",
  /** Ocean: Realistic, seeded ocean spectrum. */
  ocean: "FT_WorldOcean",
  /** Lake: Stylized Painted. */
  lake: "FT_WorldLake",
  /** River: Stylized Toon. */
  river: "FT_WorldRiver",
} as const;

type WaterKey = keyof typeof FEATURE_TEST_WORLD_WATER;

const WATER_LOOKS: Record<WaterKey, { style: WaterStyle; look: WaterStylizedLook; patch: Partial<WaterDefinition> }> = {
  // Object reflections re-render the whole main scene; the bounded Ocean keeps them.
  sea: { style: "realistic", look: "painted", patch: { objectReflections: false } },
  ocean: {
    style: "realistic",
    look: "painted",
    patch: { waveModel: "ocean", waveSeed: 7, waveHeight: 0.6, waveLength: 18, crestFoam: 0.5 },
  },
  lake: { style: "stylized", look: "painted", patch: {} },
  river: { style: "stylized", look: "toon", patch: {} },
};

const SEA = FEATURE_TEST_SEA_LEVEL;

/** Landscape: 80 m square at 64 cells (1.25 m) = 4 render chunks and 8192 collision triangles. Perf knob. */
const LAND_SIZE = 80;
const LAND_SUBDIVISIONS = 64;
/** Zone-local landscape center (x, z); its east shore faces the ocean strip. */
const LAND_CENTER = [-16, 0] as const;

// Landscape-local terrain features (metres).
const SEABED = -10;
const LAND_HEIGHT = 2;
const MOUNTAIN = { x: -20, z: 16, height: 9, radius: 9 };
const HILL = { x: -20, z: -22, height: 4.5, radius: 7 };
const LAKE = { x: 6, z: 14, width: 18, length: 13, surface: 0.5, bed: 2.5 };
const PUDDLE = { x: -12, z: -8, height: 2, radius: 4 };
const RIVER_WIDTH = 6;
/** River bed depth below the surface; banks rise 0.6 m above the surface at the footprint edge. */
const RIVER_BED = 1;
/**
 * River course from the mountain into the lake. A pinned `y` sets the surface;
 * otherwise it stays 1 m under the lowest uncarved terrain along both banks.
 */
const RIVER_COURSE: ReadonlyArray<{ x: number; z: number; scale: number; y?: number }> = [
  { x: -15, z: 25, scale: 0.8 },
  { x: -10, z: 22, scale: 0.9 },
  { x: -6, z: 18, scale: 1 },
  { x: -2.5, z: 15.2, scale: 1.2, y: LAKE.surface + 0.05 },
  { x: 2, z: 13.5, scale: 1.5, y: LAKE.surface },
];

// Zone-local sea features.
const OCEAN = { id: "ft-world-ocean", x: 36, z: 0, width: 40, length: 80 };
const LAKE_ID = "ft-world-lake";
const DRY_DOCK = { x: 20, z: -26, width: 7, length: 9 };
const MOORINGS: ReadonlyArray<{ pile: readonly [number, number]; present: readonly [number, number]; yaw: number }> = [
  { pile: [22, -2], present: [27, -2], yaw: 20 },
  { pile: [22, 8], present: [27, 9], yaw: -35 },
];
/** Free-floating ocean presents (zone-local x, z, yaw): dynamic bodies that ride the swell and never sleep. */
const OCEAN_PRESENTS: ReadonlyArray<readonly [number, number, number]> = [
  [32, -12, 10],
  [38, 0, 55],
  [44, 12, -20],
  [36, 18, 80],
  [48, -6, 35],
];

/** Holiday Pack `present-a-cube`: 0.4 m body (0.45 m lid), 0.57 m tall, origin at its base. */
const PRESENT_HALF_WIDTH = 0.21;
const PRESENT_HEIGHT = 0.57;
const PRESENT_SCALE = 2.5;

/** Main-scene island scatter (moderate showcase counts). Perf knob. */
const ISLAND_FOLIAGE: ReadonlyArray<{
  model: FeatureTestHolidayModel;
  count: number;
  seed: number;
  minScale: number;
  maxScale: number;
  minHeight: number;
  maxSlope: number;
}> = [
  { model: "tree-snow-a", count: 120, seed: 11, minScale: 0.9, maxScale: 1.6, minHeight: 1.6, maxSlope: 0.8 },
  { model: "rocks-medium", count: 36, seed: 23, minScale: 0.7, maxScale: 1.5, minHeight: -1.5, maxSlope: 1.2 },
  { model: "snow-pile", count: 70, seed: 37, minScale: 0.8, maxScale: 1.8, minHeight: 1.2, maxSlope: 0.6 },
];
const FOLIAGE_GROUP_ID = "ft-world-foliage-group";
/** `FT_Stress` Foliage: a jittered GRID × GRID carpet (72² = 5184 instances, 3 batches). Perf knob. */
const STRESS_FOLIAGE_GRID = 72;
const STRESS_FOLIAGE_SPACING = 0.42;

/** Water assets: Realistic classic and ocean spectrum, Stylized Painted and Toon. */
export async function buildFeatureTestWorld(ctx: FeatureTestContext): Promise<void> {
  for (const key of Object.keys(FEATURE_TEST_WORLD_WATER) as WaterKey[]) {
    const { style, look, patch } = WATER_LOOKS[key];
    await ctx.createAsset("Water", FEATURE_TEST_WORLD_FOLDER, FEATURE_TEST_WORLD_WATER[key], {
      build: { waterStyle: style, waterStylizedLook: look },
      payload: (payload) => ({ ...payload, ...patch }),
    });
  }
}

/**
 * `world` zone: island Landscape with Foliage, Global Water Volume at sea level,
 * Ocean, Lake, River, Puddle, Water Removal dry dock, buoyant presents (two
 * moored by Cables), static Cables, two Splines; plus the `FT_Stress` Foliage.
 */
export async function placeFeatureTestWorld(ctx: FeatureTestContext): Promise<void> {
  const zone = ctx.zone("world");
  const add = (next: SerializedActor) => ctx.addActor(next, { zone: "world" });
  const land = (x: number, y: number, z: number): Vec3 => zone.at(LAND_CENTER[0] + x, y, LAND_CENTER[1] + z);
  const island = buildIsland(requireRef(ctx.assets.materials.landscape, "the landscape Material"));
  const ground = (x: number, z: number) => landscapeHeightAt(island.data, x, z) ?? SEABED;
  /** Terrain height under a zone-local point. */
  const seabed = (x: number, z: number) => ground(x - LAND_CENTER[0], z - LAND_CENTER[1]);
  const presentModel = requireRef(ctx.assets.models["present-a-cube"], "the present-a-cube Model");
  const addPresent = (id: string, name: string, position: Vec3, yaw: number, waterActorId: string) =>
    add(floatingPresent(id, name, position, yaw, presentModel, waterActorId));
  const cableMaterial = ctx.assets.materials.surface ?? null;
  /** Landscape-local discs (x, z, radius) kept clear of foliage. */
  const keepOut: Array<readonly [number, number, number]> = [[PUDDLE.x, PUDDLE.z, PUDDLE.radius + 3]];

  // Water bodies. The Global Water Volume sits at sea level, below every zone floor.
  add(actor("ft-world-sea", "Global Sea", tf(zone.at(0, SEA, 0)), [
    comp("ft-world-sea-water", "GlobalWaterVolumeComponent", { assetGuid: waterGuid(ctx, "sea") }),
  ]));
  add(actor(OCEAN.id, "Ocean", tf(zone.at(OCEAN.x, SEA, OCEAN.z)), [
    comp("ft-world-ocean-water", "WaterOceanComponent", {
      assetGuid: waterGuid(ctx, "ocean"),
      width: OCEAN.width,
      length: OCEAN.length,
    }),
  ]));
  add(actor(LAKE_ID, "Lake", tf(land(LAKE.x, LAKE.surface, LAKE.z)), [
    comp("ft-world-lake-water", "WaterLakeComponent", {
      assetGuid: waterGuid(ctx, "lake"),
      width: LAKE.width,
      length: LAKE.length,
      depth: LAKE.bed + 0.5,
    }),
  ]));
  const source = island.riverPoints[0]!;
  add(actor("ft-world-river", "River", tf(land(source[0], 0, source[2])), [
    comp("ft-world-river-water", "WaterRiverComponent", {
      assetGuid: waterGuid(ctx, "river"),
      width: RIVER_WIDTH,
      depth: RIVER_BED + 0.5,
      flowSpeed: 2,
      curvature: 1,
      points: island.riverPoints.map(([x, y, z]) => [round(x - source[0]), y, round(z - source[2])]),
      widthScales: RIVER_COURSE.map((point) => point.scale),
    }),
  ]));
  // No Water asset: the Puddle renders and simulates with the engine's Realistic defaults.
  add(actor("ft-world-puddle", "Puddle", tf(land(PUDDLE.x, PUDDLE.height + 0.03, PUDDLE.z)), [
    comp("ft-world-puddle-water", "WaterPuddleComponent", { width: 3, length: 2 }),
  ]));
  add(dryDock(zone.at(DRY_DOCK.x, SEA, DRY_DOCK.z), seabed(DRY_DOCK.x, DRY_DOCK.z)));

  // Buoyant presents: free in the ocean, moored to piles by Cables, and one in the lake.
  OCEAN_PRESENTS.forEach(([x, z, yaw], index) => {
    addPresent(`ft-world-float-${index + 1}`, `Floating Present ${index + 1}`, zone.at(x, SEA + 0.15, z), yaw, OCEAN.id);
  });
  MOORINGS.forEach(({ pile, present: [x, z], yaw }, index) => {
    const presentId = `ft-world-moored-${index + 1}`;
    addPresent(presentId, `Moored Present ${index + 1}`, zone.at(x, SEA + 0.15, z), yaw, OCEAN.id);
    const base = seabed(pile[0], pile[1]);
    const height = SEA + 1.6 - base;
    const id = `ft-world-pile-${index + 1}`;
    add(actor(id, `Mooring Pile ${index + 1}`, tf(zone.at(pile[0], base, pile[1])), [
      postMesh(`${id}-mesh`, height, 0.5),
      comp(`${id}-line`, "CableComponent", {
        targetActorId: presentId,
        endPosition: [0, PRESENT_HEIGHT, 0],
        cableLength: 7,
        numSegments: 20,
        cableWidth: 0.06,
      }, tf([0, height - 0.2, 0])),
    ]));
  });
  addPresent("ft-world-lake-float", "Lake Present", land(LAKE.x + 3, LAKE.surface + 0.15, LAKE.z + 1), 25, LAKE_ID);

  // Landscape and its Foliage share one origin, so instance transforms are landscape-local.
  add(actor("ft-world-landscape", "Island Landscape", tf(land(0, 0, 0)), [
    comp("ft-world-landscape-terrain", "LandscapeComponent", island.properties),
  ]));

  // Static Cables: a rope across the river, a sagging power line, a swinging rope and a draped cable.
  const crossing = riverCrossing(island.riverLine);
  const crossingIds = ["ft-world-crossing-1", "ft-world-crossing-2"] as const;
  crossing.posts.forEach(([x, z], index) => {
    const id = crossingIds[index]!;
    const components: SerializedComponent[] = [postMesh(`${id}-mesh`, 2, 0.25)];
    if (index === 0) {
      components.push(comp(`${id}-rope`, "CableComponent", {
        targetActorId: crossingIds[1],
        endPosition: [0, 1.9, 0],
        cableLength: round(crossing.span * 1.12),
        numSegments: 24,
        cableWidth: 0.06,
        materialGuid: cableMaterial,
        tileMaterial: 6,
      }, tf([0, 1.9, 0])));
    }
    add(actor(id, `River Crossing Post ${index + 1}`, tf(land(x, ground(x, z), z)), components));
    keepOut.push([x, z, 1.5]);
  });

  const poles = [[-6, -30], [4, -27.5], [14, -25]] as const;
  poles.forEach(([x, z], index) => {
    const id = `ft-world-pole-${index + 1}`;
    const components: SerializedComponent[] = [postMesh(`${id}-mesh`, 5, 0.3)];
    const next = poles[index + 1];
    if (next) {
      const span = Math.hypot(next[0] - x, next[1] - z);
      components.push(comp(`${id}-wire`, "CableComponent", {
        targetActorId: `ft-world-pole-${index + 2}`,
        endPosition: [0, 4.8, 0],
        cableLength: round(span * 1.04),
        numSegments: 20,
        cableWidth: 0.04,
      }, tf([0, 4.8, 0])));
    }
    add(actor(id, `Power Line Pole ${index + 1}`, tf(land(x, ground(x, z), z)), components));
    keepOut.push([x, z, 1.5]);
  });

  const swing = [-2, -12] as const;
  add(actor("ft-world-swing", "Rope Swing", tf(land(swing[0], ground(swing[0], swing[1]), swing[1])), [
    boxMesh("ft-world-swing-leg-1", [-1.2, 1.5, 0], [0.2, 3, 0.2]),
    boxMesh("ft-world-swing-leg-2", [1.2, 1.5, 0], [0.2, 3, 0.2]),
    boxMesh("ft-world-swing-beam", [0, 3.1, 0], [2.8, 0.2, 0.2]),
    comp("ft-world-swing-rope", "CableComponent", {
      attachEnd: false,
      cableLength: 2.2,
      numSegments: 12,
      cableWidth: 0.05,
      cableForce: [0.6, 0, 0.3],
    }, tf([0, 3, 0])),
  ]));
  keepOut.push([swing[0], swing[1], 3.5]);

  // Collision-enabled cable: hangs between two pegs and drapes over a log and the terrain in Play.
  const drape = { x: 7, z: -4, half: 3 };
  const pegIds = ["ft-world-peg-1", "ft-world-peg-2"] as const;
  pegIds.forEach((id, index) => {
    const x = drape.x + (index === 0 ? -drape.half : drape.half);
    const components: SerializedComponent[] = [postMesh(`${id}-mesh`, 0.9, 0.12)];
    if (index === 0) {
      components.push(comp(`${id}-cable`, "CableComponent", {
        targetActorId: pegIds[1],
        endPosition: [0, 0.8, 0],
        cableLength: 7.2,
        numSegments: 32,
        cableWidth: 0.05,
        solverIterations: 8,
        enableCollision: true,
      }, tf([0, 0.8, 0])));
    }
    add(actor(id, `Draped Cable Peg ${index + 1}`, tf(land(x, ground(x, drape.z), drape.z)), components));
  });
  add(actor("ft-world-log", "Draped Cable Log", tf(land(drape.x, ground(drape.x, drape.z) + 0.35, drape.z)), [
    {
      ...meshComp("ft-world-log-mesh", "cylinder", { collision: "simple" }),
      transform: tf([0, 0, 0], { rotationDeg: [90, 0, 0], scale: [0.7, 3 / 1.5, 0.7] }),
    },
  ]));
  keepOut.push([drape.x, drape.z, drape.half + 2]);

  // Editor-only Splines: a closed trail around the lake and an open path up the mountain.
  const trail = Array.from({ length: 10 }, (_, index): readonly [number, number] => {
    const angle = (index / 10) * Math.PI * 2;
    return [LAKE.x + Math.cos(angle) * LAKE.width * 0.72, LAKE.z + Math.sin(angle) * LAKE.length * 0.72];
  });
  add(splineActor("ft-world-trail", "Lake Trail Spline", trail, ground, land, { closed: true, curvature: 1 }));
  const ridge = [[-12, -4.5], [-15, 2], [-18.5, 8], [-20, 13]] as const;
  add(splineActor("ft-world-ridge", "Ridge Path Spline", ridge, ground, land, { closed: false, curvature: 0.5 }));

  // Island Foliage and the Foliage Group used by the Foliage mode brush.
  const models = ctx.assets.models;
  add(actor("ft-world-foliage", "Island Foliage", tf(land(0, 0, 0)), [
    comp("ft-world-foliage-instances", "FoliageComponent", {
      groupId: FOLIAGE_GROUP_ID,
      batches: scatterIsland(island, models, keepOut),
    }),
  ]));
  const group = foliageGroup(models);
  addFoliageGroup(ctx.mainScene, group);

  // FT_Stress: one dense Foliage carpet on the stress floor.
  addFoliageGroup(ctx.stressScene, group);
  ctx.addActor(actor("ft-world-stress-foliage", "Stress Foliage", tf(stressPoint("foliage")), [
    comp("ft-world-stress-foliage-instances", "FoliageComponent", {
      groupId: FOLIAGE_GROUP_ID,
      batches: stressFoliage(models),
    }),
  ]), { scene: ctx.stressScene });
}

function waterGuid(ctx: FeatureTestContext, key: WaterKey): string {
  const name = FEATURE_TEST_WORLD_WATER[key];
  const asset = ctx.registry.getByPath(ctx.storagePath(FEATURE_TEST_WORLD_FOLDER, newAssetFileName("Water", name)));
  return requireRef(asset?.header.guid, `the ${name} Water`);
}

// ---------------------------------------------------------------------------
// Props

/** Upright cylinder standing on the actor origin, with simple collision. */
function postMesh(id: string, height: number, diameter: number): SerializedComponent {
  return {
    ...meshComp(id, "cylinder", { collision: "simple" }),
    transform: tf([0, height / 2, 0], { scale: [diameter, height / 1.5, diameter] }),
  };
}

/** Box of `size` metres centered at `center`, with simple collision. */
function boxMesh(id: string, center: Vec3, size: Vec3): SerializedComponent {
  return {
    ...meshComp(id, "box", { collision: "simple" }),
    transform: tf(center, { scale: [size[0] / 1.5, size[1] / 1.5, size[2] / 1.5] }),
  };
}

/** Dynamic present with a fitted box collider that floats on `waterActorId`. */
function floatingPresent(
  id: string,
  name: string,
  position: Vec3,
  yaw: number,
  modelGuid: string,
  waterActorId: string,
): SerializedActor {
  const center = PRESENT_HEIGHT / 2;
  const scale: Vec3 = [PRESENT_SCALE, PRESENT_SCALE, PRESENT_SCALE];
  return actor(id, name, tf(position, { rotationDeg: [0, yaw, 0], scale }), [
    meshComp(`${id}-mesh`, "box", { assetGuid: modelGuid }),
    comp(`${id}-body`, "RigidBodyComponent", { motionType: "dynamic", mass: 40, angularDamping: 0.4 }),
    comp(`${id}-collider`, "ColliderComponent", {
      shape: { kind: "box", halfExtents: { x: PRESENT_HALF_WIDTH, y: center, z: PRESENT_HALF_WIDTH } },
    }, tf([0, center, 0])),
    comp(`${id}-buoyancy`, "WaterBuoyancyComponent", {
      width: PRESENT_HALF_WIDTH * 2,
      length: PRESENT_HALF_WIDTH * 2,
      height: PRESENT_HEIGHT,
      offset: [0, center, 0],
      waterActorId,
    }),
  ]);
}

/**
 * Water Removal box cut out of the ocean at sea level, walled from the seabed
 * to just above the surface, with a hull resting on the dry floor.
 */
function dryDock(position: Vec3, seabed: number): SerializedActor {
  const wallTop = 1.2;
  const height = wallTop - (seabed - position[1]);
  const wallY = (seabed - position[1] + wallTop) / 2;
  const { width, length } = DRY_DOCK;
  return actor("ft-world-drydock", "Dry Dock", tf(position), [
    comp("ft-world-drydock-removal", "WaterRemovalVolumeComponent", { shape: "box", width, height: 6, length }),
    boxMesh("ft-world-drydock-wall-north", [0, wallY, length / 2], [width + 0.4, height, 0.4]),
    boxMesh("ft-world-drydock-wall-south", [0, wallY, -length / 2], [width + 0.4, height, 0.4]),
    boxMesh("ft-world-drydock-wall-east", [width / 2, wallY, 0], [0.4, height, length]),
    boxMesh("ft-world-drydock-wall-west", [-width / 2, wallY, 0], [0.4, height, length]),
    boxMesh("ft-world-drydock-hull", [0, seabed - position[1] + 0.8, 0], [2.4, 1.6, 6]),
  ]);
}

/** Spline through landscape-local (x, z) points, 0.25 m above the ground, local to its first point. */
function splineActor(
  id: string,
  name: string,
  course: ReadonlyArray<readonly [number, number]>,
  ground: (x: number, z: number) => number,
  land: (x: number, y: number, z: number) => Vec3,
  options: { closed: boolean; curvature: number },
): SerializedActor {
  const [ox, oz] = course[0]!;
  const oy = round(ground(ox, oz) + 0.25);
  return actor(id, name, tf(land(ox, oy, oz)), [
    comp(`${id}-curve`, "SplineComponent", {
      ...options,
      points: course.map(([x, z]) => [round(x - ox), round(ground(x, z) + 0.25 - oy), round(z - oz)]),
    }),
  ]);
}

/** Two posts facing each other across the river, 40% of the way along its centreline. */
function riverCrossing(line: readonly WaterRiverSample[]): { posts: Array<readonly [number, number]>; span: number } {
  const index = Math.floor(line.length * 0.4);
  const at = line[index]!;
  const next = line[index + 1]!;
  const length = Math.hypot(next.x - at.x, next.z - at.z) || 1;
  const [nx, nz] = [-(next.z - at.z) / length, (next.x - at.x) / length];
  const reach = at.halfWidth + 2.2;
  return {
    posts: [
      [round(at.x + nx * reach), round(at.z + nz * reach)],
      [round(at.x - nx * reach), round(at.z - nz * reach)],
    ],
    span: reach * 2,
  };
}

// ---------------------------------------------------------------------------
// Island terrain

interface Island {
  /** LandscapeComponent properties (heights to the centimetre, paint weights to 0.05). */
  properties: Record<string, unknown>;
  /** Parsed copy for height queries. */
  data: LandscapeProperties;
  /** Landscape-local river control points and the sampled centreline that carves the channel. */
  riverPoints: Vec3[];
  riverLine: WaterRiverSample[];
}

interface Channel {
  distance: number;
  halfWidth: number;
  y: number;
}

/**
 * Deterministic island heightfield: rolling grass at 2 m, a snowy mountain, a
 * hill, a flat puddle terrace, a lake basin and a river channel, sinking to the
 * seabed at every edge. Paint layers follow `landscapeMaterial`: 1 grass
 * (default), 2 snow, 3 sand, 4 exposed dark rock (steep slopes add rock by themselves).
 */
function buildIsland(materialGuid: string): Island {
  const riverPoints = riverControlPoints();
  const riverLine = waterRiverCentreline(normalizeWaterBody({
    width: RIVER_WIDTH,
    points: riverPoints,
    widthScales: RIVER_COURSE.map((point) => point.scale),
    curvature: 1,
  }, "river"));
  const side = LAND_SUBDIVISIONS + 1;
  const heights = new Array<number>(side * side);
  const weights = new Array<number>(side * side * 4);
  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      const x = (ix / LAND_SUBDIVISIONS) * LAND_SIZE - LAND_SIZE / 2;
      const z = (iz / LAND_SUBDIVISIONS) * LAND_SIZE - LAND_SIZE / 2;
      const channel = riverChannelAt(riverLine, x, z);
      const lake = lakeRadius(x, z);
      const height = round(Math.min(
        baseHeight(x, z),
        channel ? channelProfile(channel) : Infinity,
        lakeProfile(lake),
      ));
      const vertex = iz * side + ix;
      heights[vertex] = height;
      paintLayers(height, channel, lake).forEach((weight, layer) => {
        weights[vertex * 4 + layer] = weight;
      });
    }
  }
  const properties = {
    width: LAND_SIZE,
    depth: LAND_SIZE,
    subdivisions: LAND_SUBDIVISIONS,
    heights,
    weights,
    materialGuid,
    collisionsEnabled: true,
  };
  return { properties, data: parseLandscapeProperties(properties), riverPoints, riverLine };
}

/** Uncarved terrain: land, mountain, hill and puddle terrace, masked into the seabed at the shores. */
function baseHeight(x: number, z: number): number {
  let height = LAND_HEIGHT
    + 0.4 * Math.sin(0.21 * x + 0.4) * Math.cos(0.17 * z)
    + 0.2 * Math.sin(0.37 * (x + z))
    + bump(x, z, MOUNTAIN)
    + bump(x, z, HILL);
  const terrace = 1 - smooth(PUDDLE.radius, PUDDLE.radius + 3, Math.hypot(x - PUDDLE.x, z - PUDDLE.z));
  height += (PUDDLE.height - height) * terrace;
  const half = LAND_SIZE / 2;
  const shore = 22 + 2.5 * Math.sin(0.13 * z);
  const landMask = Math.min(
    smooth(-12, 4, shore - x),
    smooth(0, 9, x + half),
    smooth(0, 9, half - z),
    smooth(0, 9, z + half),
  );
  return SEABED + (height - SEABED) * landMask;
}

function bump(x: number, z: number, feature: { x: number; z: number; height: number; radius: number }): number {
  return feature.height * Math.exp(-((x - feature.x) ** 2 + (z - feature.z) ** 2) / (2 * feature.radius ** 2));
}

/** Normalized elliptical radius in the lake footprint (1 = its edge). */
function lakeRadius(x: number, z: number): number {
  return Math.hypot((x - LAKE.x) / (LAKE.width / 2), (z - LAKE.z) / (LAKE.length / 2));
}

/** Lake basin: the shoreline sits inside the ellipse so terrain hides the footprint edge. */
function lakeProfile(radius: number): number {
  return radius <= 0.95
    ? LAKE.surface - LAKE.bed + (LAKE.bed + 0.4) * smooth(0.5, 0.95, radius)
    : LAKE.surface + 0.4 + (radius - 0.95) * 8;
}

/** River cross-section: bed 1 m deep, banks 0.6 m above the surface at the footprint edge. */
function channelProfile({ distance, halfWidth, y }: Channel): number {
  return distance <= halfWidth
    ? y - RIVER_BED + (RIVER_BED + 0.6) * smooth(0.45 * halfWidth, halfWidth, distance)
    : y + 0.6 + (distance - halfWidth) * 1.2;
}

/** Nearest reach like `waterFootprint`: the segment with the deepest inset wins. */
function riverChannelAt(line: readonly WaterRiverSample[], x: number, z: number): Channel | null {
  let best: Channel | null = null;
  let bestInset = -Infinity;
  for (let index = 1; index < line.length; index++) {
    const a = line[index - 1]!;
    const b = line[index]!;
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    if (lengthSquared < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / lengthSquared));
    const distance = Math.hypot(x - a.x - t * vx, z - a.z - t * vz);
    const halfWidth = a.halfWidth + t * (b.halfWidth - a.halfWidth);
    if (halfWidth - distance > bestInset) {
      bestInset = halfWidth - distance;
      best = { distance, halfWidth, y: a.y + t * (b.y - a.y) };
    }
  }
  return best;
}

/** River control points; unpinned surfaces stay 1 m under the lowest bank along neighbouring reaches. */
function riverControlPoints(): Vec3[] {
  const points: Vec3[] = [];
  let previous = Infinity;
  RIVER_COURSE.forEach((point, index) => {
    let y = point.y;
    if (y === undefined) {
      const reach = (RIVER_WIDTH * point.scale) / 2 + 1.5;
      let low = Infinity;
      for (const other of [RIVER_COURSE[index - 1], RIVER_COURSE[index + 1]]) {
        if (!other) continue;
        low = Math.min(low, lowestAlong(point.x, point.z, other.x, other.z, reach));
      }
      for (let step = 0; step < 8; step++) {
        const angle = (step / 8) * Math.PI * 2;
        low = Math.min(low, baseHeight(point.x + Math.cos(angle) * reach, point.z + Math.sin(angle) * reach));
      }
      y = Math.min(previous - 0.15, low - 1);
    }
    previous = round(y);
    points.push([point.x, previous, point.z]);
  });
  return points;
}

/** Lowest uncarved terrain along a segment and both of its banks. */
function lowestAlong(ax: number, az: number, bx: number, bz: number, reach: number): number {
  const length = Math.hypot(bx - ax, bz - az) || 1;
  const nx = -(bz - az) / length;
  const nz = (bx - ax) / length;
  let low = Infinity;
  for (let step = 0; step <= 8; step++) {
    const t = step / 8;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    for (const side of [-1, 0, 1]) low = Math.min(low, baseHeight(x + nx * reach * side, z + nz * reach * side));
  }
  return low;
}

/** Weights for paint layers 1-4 (grass, snow, sand, rock) at one vertex. */
function paintLayers(height: number, channel: Channel | null, lake: number): [number, number, number, number] {
  const riverRock = channel ? 1 - smooth(channel.halfWidth, channel.halfWidth + 1.2, channel.distance) : 0;
  const rock = quantize(Math.max(1 - smooth(-8.5, -7, height), riverRock));
  const sand = quantize(Math.min(Math.max(1 - smooth(0.6, 1.6, height), 1 - smooth(1, 1.3, lake)), 1 - rock));
  const snow = quantize(Math.min(smooth(5.2, 6.8, height), 1 - rock - sand));
  return [quantize(Math.max(0, 1 - snow - sand - rock)), snow, sand, rock];
}

// ---------------------------------------------------------------------------
// Foliage

/** Seeded scatter over dry, gentle ground outside the lake, river banks and props. */
function scatterIsland(
  island: Island,
  models: Record<FeatureTestHolidayModel, string>,
  keepOut: ReadonlyArray<readonly [number, number, number]>,
): FoliageBatch[] {
  const extent = LAND_SIZE - 6;
  return ISLAND_FOLIAGE.map((spec) => {
    const rng = createSeededRng(spec.seed);
    const transforms: SerializedTransform[] = [];
    for (let attempt = 0; transforms.length < spec.count && attempt < spec.count * 40; attempt++) {
      const x = (rng.nextFloat() - 0.5) * extent;
      const z = (rng.nextFloat() - 0.5) * extent;
      const yaw = rng.nextFloat() * 360;
      const scale = spec.minScale + rng.nextFloat() * (spec.maxScale - spec.minScale);
      if (lakeRadius(x, z) < 1.25 || keepOut.some(([kx, kz, radius]) => Math.hypot(x - kx, z - kz) < radius)) continue;
      const channel = riverChannelAt(island.riverLine, x, z);
      if (channel && channel.distance < channel.halfWidth + 2) continue;
      const height = landscapeHeightAt(island.data, x, z);
      if (height === null || height < spec.minHeight || slopeAt(island.data, x, z) > spec.maxSlope) continue;
      transforms.push(foliageTransform(x, height - 0.05, z, yaw, scale));
    }
    return { modelGuid: requireRef(models[spec.model], `the ${spec.model} Model`), materialGuid: null, transforms };
  });
}

/** Jittered grid on the flat stress floor: half trees, then snow piles and rocks. */
function stressFoliage(models: Record<FeatureTestHolidayModel, string>): FoliageBatch[] {
  const picks: FeatureTestHolidayModel[] = ["tree-snow-a", "snow-pile", "rocks-medium"];
  const batches = picks.map((model): FoliageBatch => ({
    modelGuid: requireRef(models[model], `the ${model} Model`),
    materialGuid: null,
    transforms: [],
  }));
  const rng = createSeededRng(101);
  const extent = ((STRESS_FOLIAGE_GRID - 1) * STRESS_FOLIAGE_SPACING) / 2;
  for (let iz = 0; iz < STRESS_FOLIAGE_GRID; iz++) {
    for (let ix = 0; ix < STRESS_FOLIAGE_GRID; ix++) {
      const x = ix * STRESS_FOLIAGE_SPACING - extent + (rng.nextFloat() - 0.5) * STRESS_FOLIAGE_SPACING * 0.6;
      const z = iz * STRESS_FOLIAGE_SPACING - extent + (rng.nextFloat() - 0.5) * STRESS_FOLIAGE_SPACING * 0.6;
      const roll = rng.nextFloat();
      const yaw = rng.nextFloat() * 360;
      const scale = 0.45 + rng.nextFloat() * 0.35;
      batches[roll < 0.5 ? 0 : roll < 0.8 ? 1 : 2]!.transforms.push(foliageTransform(x, 0, z, yaw, scale));
    }
  }
  return batches;
}

function foliageGroup(models: Record<FeatureTestHolidayModel, string>): FoliageGroup {
  return {
    id: FOLIAGE_GROUP_ID,
    name: "World Island Foliage",
    models: ISLAND_FOLIAGE.map((spec) => ({
      modelGuid: requireRef(models[spec.model], `the ${spec.model} Model`),
      materialGuid: null,
      weight: spec.count,
      minScale: spec.minScale,
      maxScale: spec.maxScale,
    })),
  };
}

function addFoliageGroup(scene: SerializedScene, group: FoliageGroup): void {
  const existing = (scene.settings.foliageGroups ?? []).filter((entry) => entry.id !== group.id);
  scene.settings.foliageGroups = [...existing, group];
}

/** Compact instance transform: yaw only, uniform scale. */
function foliageTransform(x: number, y: number, z: number, yawDegrees: number, scale: number): SerializedTransform {
  const half = (yawDegrees * Math.PI) / 360;
  return {
    position: [round(x), round(y), round(z)],
    rotation: [0, round(Math.sin(half), 10000), 0, round(Math.cos(half), 10000)],
    scale: [round(scale), round(scale), round(scale)],
  };
}

function slopeAt(data: LandscapeProperties, x: number, z: number): number {
  const step = 0.75;
  const sample = (dx: number, dz: number) => landscapeHeightAt(data, x + dx, z + dz) ?? 0;
  return Math.hypot(sample(step, 0) - sample(-step, 0), sample(0, step) - sample(0, -step)) / (2 * step);
}

// ---------------------------------------------------------------------------
// Math

function smooth(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function round(value: number, scale = 100): number {
  return Math.round(value * scale) / scale;
}

function quantize(weight: number): number {
  return Math.round(Math.max(0, Math.min(1, weight)) * 20) / 20;
}
