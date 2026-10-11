import {
  parseRagdollProperties,
  type SerializedActor,
  type SerializedComponent,
  type SerializedTransform,
} from "@babylonslate/core";
import { engineScriptApiFor, type EngineScriptFunction } from "@babylonslate/object-model";
import { parseColliderProperties, parseConstraintProperties } from "@babylonslate/physics";
import {
  actor,
  comp,
  meshComp,
  requireRef,
  tf,
  type FeatureTestClassRef,
  type FeatureTestContext,
  type Vec3,
} from "./context";
import { classGraph, gExec, getVar, gNode, gWire, setVar, varMember } from "./graph";
import { stressPoint, type FeatureTestZoneId } from "./layout";

/**
 * Physics area: rigid bodies (dynamic, kinematic, static, damping, negative
 * gravity), every 3D collider shape, collision layers, a trigger, constraints
 * of every kind, ragdolls, a blocking volume and scripted Movement walkers in
 * the Physics and Constraints And Movement zones, plus the `FT_Stress` body
 * pile. Classes: `FT_PhysWalker`, `FT_PhysLaunchPad`, `FT_PhysSweeper`.
 */

const FOLDER = "Physics";

/** Project collision layer names; bit `1 << index` is the Inspector's Layer value. */
export const FEATURE_TEST_COLLISION_LAYERS = ["Default", "Dynamic", "Trigger", "Water", "Ghost"] as const;
const LAYER = { default: 1, dynamic: 2, trigger: 4, water: 8, ghost: 16 } as const;
const ALL_LAYERS = 0xffffffff;

/** Main-scene workload knobs. */
const PYRAMID_LEVELS = 5;
const CHAIN_LINKS = 8;
const WALKER_SPEED = 2;
/** Degrees per second; loop radius = speed / turn rate (≈ 2.5 m). */
const WALKER_TURN_RATE = 45;
const LAUNCH_IMPULSE = 14;
const SWEEPER_ARM = 5.6;
const SWEEPER_RING_RADIUS = 3.3;

/**
 * `FT_Stress` physics knobs: `columns × rows × layers` dynamic bodies dropped
 * as a staggered grid (0.25 m gaps) over a kinematic sweeper, ragdolls and a
 * hanging ball-socket chain.
 */
export const FEATURE_TEST_PHYSICS_STRESS = {
  columns: 8,
  rows: 8,
  layers: 5,
  spacing: 1,
  ragdolls: 6,
  chainLinks: 32,
} as const;

const PRIMITIVE = 1.5;

type Extra = Record<string, unknown>;
type MotionType = "static" | "kinematic" | "dynamic";

/** A Class plus the prefab components its scene instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

interface PhysicsRefs {
  walker: PlacedClass;
  launchPad: PlacedClass;
  sweeper: PlacedClass;
}

interface Palette {
  surface: string | null;
  instance: string | null;
  emissive: string | null;
  translucent: string | null;
}

const refsByContext = new WeakMap<FeatureTestContext, PhysicsRefs>();

/** Save the walker (Movement), launch pad (trigger) and sweeper (kinematic) Classes. */
export async function buildFeatureTestPhysics(ctx: FeatureTestContext): Promise<void> {
  const palette = paletteOf(ctx);
  const walker = await saveWalker(ctx, palette);
  const launchPad = await saveLaunchPad(ctx, palette);
  const sweeper = await saveSweeper(ctx, palette);
  refsByContext.set(ctx, { walker, launchPad, sweeper });
}

/**
 * Place the Physics and Constraints And Movement zones, the `FT_Stress`
 * physics region, and name the project collision layers.
 */
export async function placeFeatureTestPhysics(ctx: FeatureTestContext): Promise<void> {
  const refs = refsByContext.get(ctx);
  if (!refs) throw new Error("FeatureTest physics Classes must be built before placement.");
  const palette = paletteOf(ctx);
  placeBodiesZone(ctx, refs, palette);
  placeMovementZone(ctx, refs, palette);
  placeStress(ctx, refs, palette);
  ctx.patchSettings((settings) => {
    const names: readonly string[] = FEATURE_TEST_COLLISION_LAYERS;
    return {
      ...settings,
      physics: {
        ...settings.physics,
        collisionLayers: [...names, ...settings.physics.collisionLayers.filter((name) => !names.includes(name))],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Component helpers

function paletteOf(ctx: FeatureTestContext): Palette {
  const { materials } = ctx.assets;
  return {
    surface: materials.surface ?? null,
    instance: materials.surfaceInstance ?? null,
    emissive: materials.emissive ?? null,
    translucent: materials.translucent ?? null,
  };
}

const round = (value: number) => Math.round(value * 10000) / 10000;
const v3 = (x: number, y: number, z: number) => ({ x, y, z });

/** Scale turning the 1.5 m primitive box / sphere into `x × y × z` metres. */
function fit(x: number, y = x, z = x): Vec3 {
  return [x / PRIMITIVE, y / PRIMITIVE, z / PRIMITIVE];
}

/** Scale turning the 1.5 m tall, Ø1 primitive cylinder into `diameter × height`. */
function fitCylinder(diameter: number, height: number): Vec3 {
  return [diameter, height / PRIMITIVE, diameter];
}

/** Collision-free primitive sized by its component transform (actor scale stays 1). */
function visual(
  id: string,
  kind: "box" | "sphere" | "cylinder",
  options: { position?: Vec3; rotationDeg?: Vec3; scale?: Vec3; materialGuid?: string | null } = {},
): SerializedComponent {
  const mesh = meshComp(id, kind, { materialGuid: options.materialGuid ?? null });
  mesh.transform = tf(options.position ?? [0, 0, 0], { rotationDeg: options.rotationDeg, scale: options.scale });
  return mesh;
}

function body(id: string, motionType: MotionType, extra: Extra = {}): SerializedComponent {
  return comp(id, "RigidBodyComponent", { motionType, ...extra });
}

/** Collider with authored shape rows; strict (Play) validation throws at scaffold time. */
function collider(
  id: string,
  shape: Extra,
  extra: Extra = {},
  transform?: SerializedTransform,
  name?: string,
): SerializedComponent {
  const component = comp(id, "ColliderComponent", { shape, ...extra }, transform, name ? { name } : {});
  // Validate only: parsed mesh shapes hold typed arrays and must never be stored.
  parseColliderProperties(component.properties, "3d");
  return component;
}

/** Constraint owned by body A; `targetActorId` is body B's scene actor id. */
function joint(
  id: string,
  kind: "fixed" | "ballSocket" | "hinge" | "distance",
  targetActorId: string,
  extra: Extra = {},
): SerializedComponent {
  const component = comp(id, "PhysicsConstraintComponent", { kind, targetActorId, ...extra });
  parseConstraintProperties(component.properties, "3d");
  return component;
}

/** Actor with explicit body and collider plus collision-free visuals. */
function rigidActor(
  id: string,
  name: string,
  transform: SerializedTransform,
  options: {
    motion: MotionType;
    shape: Extra;
    visuals: SerializedComponent[];
    body?: Extra;
    collider?: Extra;
    extra?: SerializedComponent[];
  },
): SerializedActor {
  return actor(id, name, transform, [
    ...options.visuals,
    body(`${id}-body`, options.motion, options.body),
    collider(`${id}-collider`, options.shape, options.collider),
    ...(options.extra ?? []),
  ]);
}

function ball(
  id: string,
  name: string,
  position: Vec3,
  radius: number,
  options: { motion?: MotionType; body?: Extra; collider?: Extra; materialGuid?: string | null; extra?: SerializedComponent[] } = {},
): SerializedActor {
  return rigidActor(id, name, tf(position), {
    motion: options.motion ?? "dynamic",
    shape: { kind: "sphere", radius },
    visuals: [visual(`${id}-mesh`, "sphere", { scale: fit(radius * 2), materialGuid: options.materialGuid })],
    body: options.body,
    collider: { layer: LAYER.dynamic, ...options.collider },
    extra: options.extra,
  });
}

/** Static scenery from a primitive box with simple mesh collision (implicit static body). */
function staticBlock(
  id: string,
  name: string,
  position: Vec3,
  size: Vec3,
  options: { rotationDeg?: Vec3; materialGuid?: string | null } = {},
): SerializedActor {
  return actor(id, name, tf(position, { rotationDeg: options.rotationDeg, scale: fit(...size) }), [
    meshComp(`${id}-mesh`, "box", { collision: "simple", materialGuid: options.materialGuid ?? null }),
  ]);
}

function ragdollActor(id: string, name: string, position: Vec3, rollDeg: number, modelGuid: string): SerializedActor {
  const ragdoll = comp(`${id}-ragdoll`, "RagdollComponent", { enabled: true });
  parseRagdollProperties(ragdoll.properties);
  return actor(id, name, tf(position, { rotationDeg: [0, 0, rollDeg] }), [
    meshComp(`${id}-mesh`, "box", { assetGuid: modelGuid }),
    ragdoll,
  ]);
}

/** Static anchor plus `links` dynamic spheres, each ball-socketed to the previous one. */
function chainActors(spec: {
  id: string;
  name: string;
  anchor: Vec3;
  step: Vec3;
  links: number;
  radius: number;
  materialGuid: string | null;
}): SerializedActor[] {
  const half = v3(spec.step[0] / 2, spec.step[1] / 2, spec.step[2] / 2);
  const anchorId = `${spec.id}-anchor`;
  const actors = [ball(anchorId, `${spec.name} Anchor`, spec.anchor, spec.radius * 0.75, {
    motion: "static",
    collider: { layer: LAYER.default },
  })];
  const linkId = (index: number) => `${spec.id}-link-${String(index).padStart(2, "0")}`;
  for (let index = 1; index <= spec.links; index += 1) {
    const id = linkId(index);
    const position: Vec3 = [
      round(spec.anchor[0] + spec.step[0] * index),
      round(spec.anchor[1] + spec.step[1] * index),
      round(spec.anchor[2] + spec.step[2] * index),
    ];
    actors.push(ball(id, `${spec.name} Link ${index}`, position, spec.radius, {
      body: { mass: 0.5, linearDamping: 0.05 },
      materialGuid: spec.materialGuid,
      extra: [joint(`${id}-joint`, "ballSocket", index === 1 ? anchorId : linkId(index - 1), {
        anchorA: v3(-half.x, -half.y, -half.z),
        anchorB: half,
      })],
    }));
  }
  return actors;
}

/** Hexagonal prism point cloud (fits inside the Ø1 × 1.5 m primitive cylinder). */
function hexPrismPoints(radius: number, halfHeight: number): Array<{ x: number; y: number; z: number }> {
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (const y of [-halfHeight, halfHeight]) {
    for (let index = 0; index < 6; index += 1) {
      const angle = (index * Math.PI) / 3;
      points.push(v3(round(radius * Math.cos(angle)), y, round(radius * Math.sin(angle))));
    }
  }
  return points;
}

/**
 * Inward-facing ring wall as authored triangle-mesh rows. Winding matches
 * landscape collision (front face opposite the right-handed cross product).
 */
function ringWallShape(radius: number, height: number, segments: number): Extra {
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const x = round(radius * Math.cos(angle));
    const z = round(radius * Math.sin(angle));
    vertices.push(v3(x, 0, z), v3(x, height, z));
  }
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    indices.push(2 * index, 2 * index + 1, 2 * next, 2 * next, 2 * index + 1, 2 * next + 1);
  }
  return { kind: "mesh", vertices, indices };
}

/** V-shaped trough (6 m wide, 1.2 m deep, 2 m long) with upward-facing triangles. */
const TROUGH_HALF_WIDTH = 3;
const TROUGH_DEPTH = 1.2;
const TROUGH_SHAPE: Extra = {
  kind: "mesh",
  vertices: [
    v3(-TROUGH_HALF_WIDTH, TROUGH_DEPTH, -1), v3(0, 0, -1), v3(TROUGH_HALF_WIDTH, TROUGH_DEPTH, -1),
    v3(-TROUGH_HALF_WIDTH, TROUGH_DEPTH, 1), v3(0, 0, 1), v3(TROUGH_HALF_WIDTH, TROUGH_DEPTH, 1),
  ],
  indices: [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4],
};

/** Class instance rows: `prefab-<suffix>` becomes `<actorId>-<suffix>` with `sourceId` kept. */
function instanceComponents(actorId: string, templates: readonly SerializedComponent[]): SerializedComponent[] {
  const idOf = (id: string) => `${actorId}-${id.replace(/^prefab-/, "")}`;
  return templates.map((template) => ({
    ...structuredClone(template),
    id: idOf(template.id),
    parentId: template.parentId ? idOf(template.parentId) : null,
    sourceId: template.id,
  }));
}

function classActor(
  placed: PlacedClass,
  id: string,
  name: string,
  transform: SerializedTransform,
  properties?: Record<string, unknown>,
): SerializedActor {
  return actor(id, name, transform, instanceComponents(id, placed.components), {
    classId: placed.ref.classId,
    ...(properties ? { properties } : {}),
  });
}

function caption(id: string, name: string, position: Vec3, text: string, fontAssetGuid: string | null): SerializedActor {
  return actor(id, name, tf(position), [
    comp(`${id}-text`, "Text3DComponent", {
      text,
      size: 0.4,
      color: [0.85, 0.93, 1],
      alignment: "center",
      fontAssetGuid,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Classes

function movementFunction(name: string): EngineScriptFunction {
  const fn = engineScriptApiFor("MovementComponent")?.functions?.find((entry) => entry.name === name);
  if (!fn) throw new Error(`MovementComponent has no "${name}" function.`);
  return fn;
}

/** Call node for an engine component function on a wired component reference. */
function componentCall(id: string, x: number, y: number, classId: string, fn: EngineScriptFunction) {
  return gNode(id, "functions.call", x, y, {
    functionName: fn.name,
    classId,
    implicitSelf: false,
    pins: fn.pins.map((pin) => ({ ...pin })),
    runtime: fn.runtime,
  });
}

/**
 * Movement pawn: each Tick advances Heading by TurnRate, converts a forward
 * stick through Convert Input and sets it as persistent Movement input, then
 * faces the heading, so the pawn walks a fixed loop. `Hop` instances jump on
 * Begin Play and on every landing.
 */
async function saveWalker(ctx: FeatureTestContext, palette: Palette): Promise<PlacedClass> {
  const convert = movementFunction("Convert Input");
  const setInput = movementFunction("Set Movement Input");
  const jump = movementFunction("Jump");
  const turnRate = varMember("ft-phys-var-turn-rate", "TurnRate", "float", WALKER_TURN_RATE, { category: "Walker" });
  const heading = varMember("ft-phys-var-heading", "Heading", "float", 0, { category: "Walker" });
  const hop = varMember("ft-phys-var-hop", "Hop", "bool", false, { category: "Walker" });
  // Capsule: radius 0.4, height 1.8, centred on the actor origin.
  const components: SerializedComponent[] = [
    visual("prefab-body", "cylinder", { position: [0, -0.3, 0], scale: fitCylinder(0.8, 1.2), materialGuid: palette.surface }),
    visual("prefab-head", "sphere", { position: [0, 0.55, 0], scale: fit(0.6), materialGuid: palette.surface }),
    visual("prefab-visor", "box", { position: [0, 0.6, 0.28], scale: fit(0.4, 0.12, 0.15), materialGuid: palette.emissive }),
    comp("prefab-movement", "MovementComponent", {
      inputSpace: "world",
      maxSpeed: WALKER_SPEED,
      acceleration: 20,
      jumpSpeed: 4,
    }, undefined, { name: "Movement" }),
  ];
  const graph = classGraph({
    members: [turnRate, heading, hop],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      getVar("get-heading", heading, 0, 160),
      getVar("get-turn-rate", turnRate, 0, 260),
      gNode("turn-step", "math.mul", 220, 220),
      gNode("next-heading", "math.add", 420, 180),
      gNode("wrap-heading", "math.mod", 620, 180, { "default:b": 360 }),
      setVar("set-heading", heading, 820, 0),
      gNode("movement", "component.getNamed", 820, 360, {
        componentClassId: "MovementComponent",
        implicitSelf: true,
      }),
      gNode("forward", "vector.make2", 820, 240, { "default:x": 0, "default:y": 1 }),
      componentCall("convert", 1080, 0, "MovementComponent", convert),
      componentCall("drive", 1340, 0, "MovementComponent", setInput),
      gNode("face", "struct.makeRotator", 1340, 240, { "default:pitch": 0, "default:roll": 0 }),
      gNode("self", "actor.getSelf", 1340, 400),
      gNode("turn", "transform.setRotation", 1600, 0),
      gNode("begin", "flow.event.beginPlay", 0, 640),
      gNode("landed", "flow.event.movementLanded", 0, 800, {
        componentId: "prefab-movement",
        eventQualifier: "Movement",
        title: "Event On Movement Landed (Movement)",
      }),
      getVar("get-hop", hop, 240, 900),
      gNode("hop-branch", "flow.branch", 460, 700),
      componentCall("jump", 720, 700, "MovementComponent", jump),
    ],
    edges: [
      gExec("tick", "set-heading"),
      gWire("set-heading", "execOut", "convert", "exec"),
      gWire("convert", "then", "drive", "exec"),
      gWire("drive", "then", "turn", "execIn"),
      gWire("tick", "deltaSeconds", "turn-step", "a"),
      gWire("get-turn-rate", "value", "turn-step", "b"),
      gWire("get-heading", "value", "next-heading", "a"),
      gWire("turn-step", "out", "next-heading", "b"),
      gWire("next-heading", "out", "wrap-heading", "a"),
      gWire("wrap-heading", "out", "set-heading", "value"),
      gWire("movement", "out", "convert", "target"),
      gWire("forward", "out", "convert", "input"),
      gWire("set-heading", "out", "convert", "yaw"),
      gWire("movement", "out", "drive", "target"),
      gWire("convert", "direction", "drive", "direction"),
      gWire("set-heading", "out", "face", "yaw"),
      gWire("self", "out", "turn", "target"),
      gWire("face", "out", "turn", "rotation"),
      gExec("begin", "hop-branch"),
      gExec("landed", "hop-branch"),
      gWire("get-hop", "value", "hop-branch", "condition"),
      gWire("hop-branch", "true", "jump", "exec"),
      gWire("movement", "out", "jump", "target"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: "FT_PhysWalker", parentClass: "Actor", graph });
  return { ref, components };
}

/** Static trigger volume that launches whatever enters it straight up. */
async function saveLaunchPad(ctx: FeatureTestContext, palette: Palette): Promise<PlacedClass> {
  const impulse = varMember("ft-phys-var-launch-impulse", "LaunchImpulse", "float", LAUNCH_IMPULSE, { category: "Launch Pad" });
  const components: SerializedComponent[] = [
    visual("prefab-plate", "box", { position: [0, 0.1, 0], scale: fit(2, 0.2, 2), materialGuid: palette.emissive }),
    body("prefab-body", "static"),
    collider(
      "prefab-trigger",
      { kind: "box", halfExtents: v3(1, 0.5, 1) },
      { isTrigger: true, layer: LAYER.trigger, renderInGame: true },
      tf([0, 0.5, 0]),
      "Launch Trigger",
    ),
  ];
  const graph = classGraph({
    members: [impulse],
    components,
    actorDefaults: { generateOverlapEvents: true, eventTick: "disabled" },
    nodes: [
      gNode("overlap", "flow.event.beginOverlap", 0, 0, {
        componentId: "prefab-trigger",
        eventQualifier: "Launch Trigger",
        title: "Event On Begin Overlap (Launch Trigger)",
      }),
      getVar("get-impulse", impulse, 0, 180),
      gNode("up", "vector.make3", 240, 160, { "default:x": 0, "default:z": 0 }),
      gNode("launch", "physics.addImpulse", 480, 0, { "default:strength": 1 }),
    ],
    edges: [
      gExec("overlap", "launch"),
      gWire("overlap", "instigator", "launch", "target"),
      gWire("get-impulse", "value", "up", "y"),
      gWire("up", "out", "launch", "impulse"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: "FT_PhysLaunchPad", parentClass: "Actor", graph });
  return { ref, components };
}

/** Kinematic paddle: Tick yaws the actor, which drives the kinematic body into dynamic bodies. */
async function saveSweeper(ctx: FeatureTestContext, palette: Palette): Promise<PlacedClass> {
  const spinRate = varMember("ft-phys-var-spin-rate", "SpinRate", "float", 45, { category: "Sweeper" });
  const components: SerializedComponent[] = [
    visual("prefab-hub", "cylinder", { position: [0, 0, 0], scale: fitCylinder(0.5, 0.7), materialGuid: palette.surface }),
    visual("prefab-arm", "box", { scale: fit(SWEEPER_ARM, 0.3, 0.3), materialGuid: palette.emissive }),
    body("prefab-body", "kinematic"),
    collider("prefab-arm-collider", { kind: "box", halfExtents: v3(SWEEPER_ARM / 2, 0.15, 0.15) }),
  ];
  const graph = classGraph({
    members: [spinRate],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      getVar("get-spin-rate", spinRate, 0, 160),
      gNode("degrees", "math.mul", 240, 120),
      gNode("yaw", "struct.makeRotator", 460, 120, { "default:pitch": 0, "default:roll": 0 }),
      gNode("self", "actor.getSelf", 240, 300),
      gNode("current", "transform.getRotation", 460, 300),
      gNode("combine", "rotator.combine", 700, 200),
      gNode("turn", "transform.setRotation", 940, 0),
    ],
    edges: [
      gExec("tick", "turn"),
      gWire("tick", "deltaSeconds", "degrees", "a"),
      gWire("get-spin-rate", "value", "degrees", "b"),
      gWire("degrees", "out", "yaw", "yaw"),
      gWire("self", "out", "current", "target"),
      gWire("self", "out", "turn", "target"),
      gWire("current", "out", "combine", "a"),
      gWire("yaw", "out", "combine", "b"),
      gWire("combine", "out", "turn", "rotation"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: "FT_PhysSweeper", parentClass: "Actor", graph });
  return { ref, components };
}

// ---------------------------------------------------------------------------
// Main scene: Physics zone (bodies, colliders, layers, trigger, kinematic)

function zoneAdder(ctx: FeatureTestContext, zone: FeatureTestZoneId) {
  return (next: SerializedActor) => ctx.addActor(next, { zone });
}

/** 3 × 3 cells (centres x −8 / 0 / 8, z −7.5 / 0 / 7.5), each captioned at its front edge. */
function placeBodiesZone(ctx: FeatureTestContext, refs: PhysicsRefs, palette: Palette): void {
  const zone = ctx.zone("physics");
  const at = zone.at;
  const add = zoneAdder(ctx, "physics");
  const font = ctx.assets.fonts.facetype || null;
  zone.floor();
  const label = (id: string, x: number, z: number, text: string) =>
    add(caption(`ft-phys-caption-${id}`, `${text} Caption`, at(x, 0.3, z - 3.4), text, font));

  // Collider shapes: one dynamic body per primitive and hull, tumbling onto the floor.
  label("shapes", -8, -7.5, "Collider Shapes");
  add(rigidActor("ft-phys-shape-box", "Box Collider Body", tf(at(-10.5, 2.5, -9.5), { rotationDeg: [25, 0, 35] }), {
    motion: "dynamic",
    shape: { kind: "box", halfExtents: v3(0.5, 0.5, 0.5) },
    visuals: [visual("ft-phys-shape-box-mesh", "box", { scale: fit(1), materialGuid: palette.surface })],
    collider: { friction: 0.6, restitution: 0.1, layer: LAYER.dynamic },
  }));
  add(rigidActor("ft-phys-shape-capsule", "Capsule Collider Body", tf(at(-8, 2.5, -9.5), { rotationDeg: [0, 0, 70] }), {
    motion: "dynamic",
    shape: { kind: "capsule", radius: 0.4, halfHeight: 0.5 },
    visuals: [
      visual("ft-phys-shape-capsule-mesh", "cylinder", { scale: fitCylinder(0.8, 1), materialGuid: palette.instance }),
      visual("ft-phys-shape-capsule-cap-top", "sphere", { position: [0, 0.5, 0], scale: fit(0.8), materialGuid: palette.instance }),
      visual("ft-phys-shape-capsule-cap-bottom", "sphere", { position: [0, -0.5, 0], scale: fit(0.8), materialGuid: palette.instance }),
    ],
    collider: { layer: LAYER.dynamic, renderInGame: true },
  }));
  add(rigidActor("ft-phys-shape-convex", "Convex Hull Body", tf(at(-5.5, 2.5, -9.5), { rotationDeg: [0, 0, 80] }), {
    motion: "dynamic",
    shape: { kind: "convex", points: hexPrismPoints(0.5, 0.75) },
    visuals: [visual("ft-phys-shape-convex-mesh", "cylinder", { materialGuid: palette.surface })],
    body: { mass: 2 },
    collider: { layer: LAYER.dynamic, renderInGame: true },
  }));
  add(ball("ft-phys-shape-bouncy", "Bouncy Sphere", at(-10, 6, -5.5), 0.5, {
    materialGuid: palette.emissive,
    collider: { restitution: 0.9 },
  }));
  add(rigidActor("ft-phys-shape-cylinder", "Cylinder Collider Body", tf(at(-6.5, 2, -5.5), { rotationDeg: [0, 0, 15] }), {
    motion: "dynamic",
    shape: { kind: "cylinder", radius: 0.5, height: 1.5 },
    visuals: [visual("ft-phys-shape-cylinder-mesh", "cylinder", { materialGuid: palette.instance })],
    collider: { restitution: 0.2, layer: LAYER.dynamic },
  }));

  // Friction: a 20° static ramp; the frictionless box slides into the bumper, the grippy one stays.
  label("ramp", 0, -7.5, "Friction Ramp");
  const slope = 20;
  const sin = Math.sin((slope * Math.PI) / 180);
  const cos = Math.cos((slope * Math.PI) / 180);
  const rampCenter: Vec3 = [0, 0.78, -7.5];
  add(staticBlock("ft-phys-ramp", "Friction Ramp", at(...rampCenter), [4, 0.2, 2.4], {
    rotationDeg: [0, 0, slope],
    materialGuid: palette.surface,
  }));
  add(staticBlock("ft-phys-ramp-bumper", "Ramp Bumper", at(-2.4, 0.3, -7.5), [0.3, 0.6, 2.4]));
  // On the slope surface 1.1 m up from the middle, 2 cm above it.
  const lift = 0.1 + 0.375 + 0.02;
  const slopeX = round(rampCenter[0] - lift * sin + 1.1 * cos);
  const slopeY = round(rampCenter[1] + lift * cos + 1.1 * sin);
  for (const [id, name, z, friction] of [
    ["ft-phys-ramp-slider", "Frictionless Slider", -8.1, 0],
    ["ft-phys-ramp-sticker", "High Friction Sticker", -6.9, 1],
  ] as const) {
    add(rigidActor(id, name, tf(at(slopeX, slopeY, z), { rotationDeg: [0, 0, slope] }), {
      motion: "dynamic",
      shape: { kind: "box", halfExtents: v3(0.375, 0.375, 0.375) },
      visuals: [visual(`${id}-mesh`, "box", { scale: fit(0.75), materialGuid: friction === 0 ? palette.emissive : palette.instance })],
      collider: { friction, layer: LAYER.dynamic },
    }));
  }

  // Static triangle mesh: a V trough the ball rolls back and forth in.
  label("trough", 8, -7.5, "Triangle Mesh Trough");
  const slant = Math.atan2(TROUGH_DEPTH, TROUGH_HALF_WIDTH);
  const plankLength = round(Math.hypot(TROUGH_HALF_WIDTH, TROUGH_DEPTH));
  const plank = (side: -1 | 1) => visual(`ft-phys-trough-plank-${side < 0 ? "left" : "right"}`, "box", {
    position: [round(side * (TROUGH_HALF_WIDTH / 2 + 0.03 * Math.sin(slant))), round(TROUGH_DEPTH / 2 - 0.03 * Math.cos(slant)), 0],
    rotationDeg: [0, 0, round((side * slant * 180) / Math.PI)],
    scale: fit(plankLength, 0.06, 2),
    materialGuid: palette.surface,
  });
  add(rigidActor("ft-phys-trough", "Triangle Mesh Trough", tf(at(8, 0, -7.5)), {
    motion: "static",
    shape: TROUGH_SHAPE,
    visuals: [plank(-1), plank(1)],
    collider: { renderInGame: true },
  }));
  const rollX = -2.4;
  const rollRadius = 0.3;
  add(ball("ft-phys-trough-ball", "Trough Ball", at(round(8 + rollX + (rollRadius + 0.03) * Math.sin(slant)),
    round((-rollX / TROUGH_HALF_WIDTH) * TROUGH_DEPTH + (rollRadius + 0.03) * Math.cos(slant)), -7.5), rollRadius, {
    materialGuid: palette.emissive,
  }));

  // Stack: settling pyramid of simple-collision boxes (no explicit Collider needed).
  label("stack", -8, 0, "Dynamic Stack");
  for (let level = 0, index = 1; level < PYRAMID_LEVELS; level += 1) {
    const count = PYRAMID_LEVELS - level;
    for (let column = 0; column < count; column += 1, index += 1) {
      const id = `ft-phys-stack-${String(index).padStart(2, "0")}`;
      add(actor(id, `Stack Box ${index}`,
        tf(at(round(-8 + (column - (count - 1) / 2) * 0.8), round(0.385 + level * 0.77), 0), { scale: [0.5, 0.5, 0.5] }),
        [
          meshComp(`${id}-mesh`, "box", { collision: "simple", materialGuid: index % 2 ? palette.surface : palette.instance }),
          body(`${id}-body`, "dynamic"),
        ]));
    }
  }

  // Gravity scale and damping: a balloon floats up to a ceiling, a damped drop sinks slowly.
  label("gravity", 0, 0, "Gravity And Damping");
  add(staticBlock("ft-phys-ceiling", "Balloon Ceiling", at(-1.5, 5.5, 0), [2.5, 0.3, 2.5], { materialGuid: palette.surface }));
  add(ball("ft-phys-balloon", "Negative Gravity Balloon", at(-1.5, 1.2, 0), 0.6, {
    materialGuid: palette.translucent,
    body: { mass: 0.5, gravityScale: -0.3, linearDamping: 0.6, angularDamping: 0.5 },
  }));
  add(ball("ft-phys-damped", "Damped Drop", at(1.5, 6, 0), 0.4, {
    materialGuid: palette.instance,
    body: { linearDamping: 4, angularDamping: 2 },
  }));

  // Collision layers: the Ghost wall blocks the default-mask ball; the masked ball falls through.
  label("layers", 8, 0, "Collision Layers");
  add(rigidActor("ft-phys-ghost-wall", "Ghost Layer Wall", tf(at(8, 1.5, 0)), {
    motion: "static",
    shape: { kind: "box", halfExtents: v3(1, 1.5, 1) },
    visuals: [visual("ft-phys-ghost-wall-mesh", "box", { scale: fit(2, 3, 2), materialGuid: palette.translucent })],
    collider: { layer: LAYER.ghost },
  }));
  add(ball("ft-phys-ghost-pass", "Ghost Pass Ball", at(7.6, 6, 0), 0.35, {
    materialGuid: palette.emissive,
    collider: { mask: ALL_LAYERS - LAYER.ghost },
  }));
  add(ball("ft-phys-ghost-blocked", "Ghost Blocked Ball", at(8.4, 6.5, 0), 0.35, { materialGuid: palette.instance }));

  // Trigger: the launch pad's overlap event launches the ball on every entry.
  label("trigger", -8, 7.5, "Trigger Launch Pad");
  add(classActor(refs.launchPad, "ft-phys-launch-pad", "Launch Pad", tf(at(-8, 0, 7.5))));
  add(ball("ft-phys-launch-ball", "Launch Ball", at(-8, 4, 7.5), 0.35, { materialGuid: palette.surface }));

  // Kinematic: a scripted sweeper stirs balls inside a static triangle-mesh ring.
  // Captioned 0.5 m further forward so the text clears the ring wall.
  label("kinematic", 4, 7, "Kinematic Sweeper");
  add(classActor(refs.sweeper, "ft-phys-sweeper", "Kinematic Sweeper", tf(at(4, 0.35, 7.5))));
  const ringSegments = 16;
  const ringPlanks: SerializedComponent[] = [];
  for (let index = 0; index < ringSegments; index += 1) {
    const angle = ((index + 0.5) / ringSegments) * Math.PI * 2;
    const radius = SWEEPER_RING_RADIUS + 0.05;
    ringPlanks.push(visual(`ft-phys-sweeper-ring-plank-${String(index + 1).padStart(2, "0")}`, "box", {
      position: [round(radius * Math.cos(angle)), 0.4, round(radius * Math.sin(angle))],
      rotationDeg: [0, round(-((angle * 180) / Math.PI + 90)), 0],
      scale: fit(round(2 * SWEEPER_RING_RADIUS * Math.sin(Math.PI / ringSegments) + 0.04), 0.8, 0.1),
      materialGuid: palette.surface,
    }));
  }
  add(rigidActor("ft-phys-sweeper-ring", "Sweeper Ring Wall", tf(at(4, 0, 7.5)), {
    motion: "static",
    shape: ringWallShape(SWEEPER_RING_RADIUS, 0.8, ringSegments),
    visuals: ringPlanks,
    collider: { renderInGame: true },
  }));
  for (let index = 0; index < 4; index += 1) {
    const angle = ((45 + index * 90) * Math.PI) / 180;
    add(ball(`ft-phys-sweeper-ball-${index + 1}`, `Sweeper Ball ${index + 1}`,
      at(round(4 + 1.8 * Math.cos(angle)), 0.32, round(7.5 + 1.8 * Math.sin(angle))), 0.3, {
        materialGuid: index % 2 ? palette.emissive : palette.instance,
        body: { mass: 0.5 },
      }));
  }
}

// ---------------------------------------------------------------------------
// Main scene: Constraints And Movement zone

function placeMovementZone(ctx: FeatureTestContext, refs: PhysicsRefs, palette: Palette): void {
  const zone = ctx.zone("movement");
  const at = zone.at;
  const add = zoneAdder(ctx, "movement");
  const font = ctx.assets.fonts.facetype || null;
  const mannequin = requireRef(ctx.assets.mannequin.modelGuid, "the Mannequin Model");
  zone.floor();
  const label = (id: string, x: number, z: number, text: string) =>
    add(caption(`ft-phys-caption-${id}`, `${text} Caption`, at(x, 0.3, z - 3.4), text, font));
  const pivot = (id: string, name: string, position: Vec3) =>
    ball(id, name, position, 0.15, { motion: "static", collider: { layer: LAYER.default }, materialGuid: palette.surface });

  // Ball-socket pendulum swinging in the XY plane (no damping: continuous motion).
  label("pendulum", -9.5, -7.5, "Ball Socket Pendulum");
  add(pivot("ft-phys-pendulum-pivot", "Pendulum Pivot", at(-9.5, 6, -8)));
  add(ball("ft-phys-pendulum-bob", "Pendulum Bob", at(-7.5, 6, -8), 0.375, {
    materialGuid: palette.emissive,
    body: { mass: 2 },
    extra: [joint("ft-phys-pendulum-joint", "ballSocket", "ft-phys-pendulum-pivot", {
      anchorA: v3(-2, 0, 0),
      anchorB: v3(0, 0, 0),
    })],
  }));

  // Distance rod: the bob keeps exactly 3 m from its pivot.
  label("distance", -1.5, -7.5, "Distance Rod");
  add(pivot("ft-phys-distance-pivot", "Distance Pivot", at(-1.5, 6, -8)));
  add(ball("ft-phys-distance-bob", "Distance Bob", at(1.5, 6, -8), 0.375, {
    materialGuid: palette.instance,
    extra: [joint("ft-phys-distance-joint", "distance", "ft-phys-distance-pivot", { distance: 3 })],
  }));

  // Hinge about Z with ±60° limits: the flap drops and stops at the limit.
  label("hinge", 7, -7.5, "Hinge With Limits");
  add(rigidActor("ft-phys-hinge-post", "Hinge Post", tf(at(5.5, 4, -8)), {
    motion: "static",
    shape: { kind: "box", halfExtents: v3(0.2, 0.2, 0.2) },
    visuals: [visual("ft-phys-hinge-post-mesh", "box", { scale: fit(0.4), materialGuid: palette.surface })],
  }));
  add(rigidActor("ft-phys-hinge-flap", "Hinge Flap", tf(at(6.7, 4, -8)), {
    motion: "dynamic",
    shape: { kind: "box", halfExtents: v3(1, 0.1, 0.3) },
    visuals: [visual("ft-phys-hinge-flap-mesh", "box", { scale: fit(2, 0.2, 0.6), materialGuid: palette.emissive })],
    collider: { layer: LAYER.dynamic },
    extra: [joint("ft-phys-hinge-joint", "hinge", "ft-phys-hinge-post", {
      anchorA: v3(-1, 0, 0),
      anchorB: v3(0.2, 0, 0),
      axisA: v3(0, 0, 1),
      axisB: v3(0, 0, 1),
      referenceAxisA: v3(1, 0, 0),
      referenceAxisB: v3(1, 0, 0),
      limitsEnabled: true,
      minAngle: -60,
      maxAngle: 60,
    })],
  }));

  // Ball-socket chain released horizontally (perf knob CHAIN_LINKS).
  label("chain", -8, 0, "Ball Socket Chain");
  for (const link of chainActors({
    id: "ft-phys-chain",
    name: "Chain",
    anchor: at(-8, 7, 0),
    step: [0.5, 0, 0],
    links: CHAIN_LINKS,
    radius: 0.2,
    materialGuid: palette.instance,
  })) add(link);

  // Ragdoll: the Mannequin Model collapses into articulated bodies in Play.
  label("ragdoll", 0, 0, "Ragdoll");
  add(ragdollActor("ft-phys-ragdoll", "Ragdoll Mannequin", at(0, 3, 0), 25, mannequin));

  // Fixed weld: two boxes joined at a shared edge fall and tip over as one body.
  label("weld", 8, 0, "Fixed Weld");
  const weldBox = (id: string, name: string, position: Vec3, extra: SerializedComponent[] = []) =>
    rigidActor(id, name, tf(position), {
      motion: "dynamic",
      shape: { kind: "box", halfExtents: v3(0.5, 0.5, 0.5) },
      visuals: [visual(`${id}-mesh`, "box", { scale: fit(1), materialGuid: palette.surface })],
      collider: { layer: LAYER.dynamic },
      extra,
    });
  add(weldBox("ft-phys-weld-a", "Weld Box A", at(7.5, 2, 0)));
  add(weldBox("ft-phys-weld-b", "Weld Box B", at(8.5, 3, 0), [
    joint("ft-phys-weld-joint", "fixed", "ft-phys-weld-a", {
      anchorA: v3(-0.5, -0.5, 0),
      anchorB: v3(0.5, 0.5, 0),
    }),
  ]));

  // Blocking Volume: invisible in Play, yet the ball and crate rest on it.
  label("blocking", -8, 7.5, "Blocking Volume");
  add(actor("ft-phys-blocking-shelf", "Invisible Shelf", tf(at(-8, 2.5, 7.5), { scale: [3, 0.3, 3] }), [
    comp("ft-phys-blocking-shelf-volume", "BlockingVolumeComponent"),
  ]));
  add(ball("ft-phys-blocking-ball", "Shelf Ball", at(-8.5, 5, 7.3), 0.4, { materialGuid: palette.emissive }));
  add(rigidActor("ft-phys-blocking-crate", "Shelf Crate", tf(at(-7.2, 5.5, 7.9)), {
    motion: "dynamic",
    shape: { kind: "box", halfExtents: v3(0.3, 0.3, 0.3) },
    visuals: [visual("ft-phys-blocking-crate-mesh", "box", { scale: fit(0.6), materialGuid: palette.instance })],
    collider: { layer: LAYER.dynamic },
  }));

  // Movement: two walkers chase each other around one loop; the second hops.
  label("walkers", 4, 7, "Movement Walkers");
  const loopRadius = round(WALKER_SPEED / ((WALKER_TURN_RATE * Math.PI) / 180));
  add(classActor(refs.walker, "ft-phys-walker-a", "Movement Walker A", tf(at(round(4 - loopRadius), 1, 7))));
  add(classActor(refs.walker, "ft-phys-walker-b", "Movement Walker B",
    tf(at(round(4 + loopRadius), 1, 7), { rotationDeg: [0, 180, 0] }),
    { Heading: 180, Hop: true }));
}

// ---------------------------------------------------------------------------
// FT_Stress physics region

function placeStress(ctx: FeatureTestContext, refs: PhysicsRefs, palette: Palette): void {
  const scene = ctx.stressScene;
  const add = (next: SerializedActor) => ctx.addActor(next, { scene });
  const { columns, rows, layers, spacing, ragdolls, chainLinks } = FEATURE_TEST_PHYSICS_STRESS;
  const originX = -14;
  const originZ = -7;
  let index = 0;
  for (let layer = 0; layer < layers; layer += 1) {
    // Odd layers shift half a cell so the grid collapses into a pile instead of stacking.
    const stagger = layer % 2 ? spacing / 2 : 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        index += 1;
        const id = `ft-phys-stress-body-${String(index).padStart(3, "0")}`;
        const kind = (column + row + layer) % 2 ? "sphere" : "box";
        add(actor(id, `Stress Body ${index}`,
          tf(stressPoint("physics", [originX + column * spacing + stagger, 2.5 + layer * spacing, originZ + row * spacing + stagger]), {
            scale: [0.5, 0.5, 0.5],
          }),
          [
            meshComp(`${id}-mesh`, kind, { collision: "simple", materialGuid: kind === "box" ? palette.surface : palette.instance }),
            body(`${id}-body`, "dynamic"),
          ]));
      }
    }
  }
  // A wide sweeper under the pile keeps it moving after it settles.
  const pileX = originX + ((columns - 1) * spacing + spacing / 2) / 2;
  const pileZ = originZ + ((rows - 1) * spacing + spacing / 2) / 2;
  add(classActor(refs.sweeper, "ft-phys-stress-sweeper", "Stress Sweeper",
    tf(stressPoint("physics", [pileX, 0.35, pileZ]), { scale: [1.6, 1, 1.6] })));

  const mannequin = requireRef(ctx.assets.mannequin.modelGuid, "the Mannequin Model");
  for (let ragdoll = 0; ragdoll < ragdolls; ragdoll += 1) {
    add(ragdollActor(`ft-phys-stress-ragdoll-${ragdoll + 1}`, `Stress Ragdoll ${ragdoll + 1}`,
      stressPoint("physics", [4, 3, -10 + ragdoll * 4]), ragdoll % 2 ? -25 : 25, mannequin));
  }

  for (const link of chainActors({
    id: "ft-phys-stress-chain",
    name: "Stress Chain",
    anchor: stressPoint("physics", [11, 14, 0]),
    step: [0, 0, 0.4],
    links: chainLinks,
    radius: 0.15,
    materialGuid: palette.instance,
  })) add(link);
}
