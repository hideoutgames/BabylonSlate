import {
  ANIM_EXIT_TIME_REACHED_TYPE,
  ANIM_RULE_ENTER_NODE_ID,
  animGraphMembersFromVariables,
  createDefaultAnimationObjectGraph,
  createDefaultTransitionRuleGraph,
  validateAnimGraph,
  type AnimGraphDocument,
  type AnimGraphVariable,
  type AnimState,
  type AnimTransition,
} from "@haptic/anim-graph";
import { normalizeAnimationPayload } from "@haptic/assets";
import {
  createDefaultScene,
  lookAtRotation,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import { animClipCatalogFromAssets } from "../anim-clip-catalog";
import {
  actor,
  comp,
  meshComp,
  requireRef,
  SCENE_SAVE_ORDER,
  tf,
  instanceComponents,
  type FeatureTestClassRef,
  type FeatureTestContext,
  type Vec3,
} from "./context";
import { classGraph, gChain, gExec, getVar, gNode, gWire, setVar, varMember } from "./graph";
import { playerNode, playerState, poseGraph, singleMachineGraph, type FeatureTestClip } from "./anim-pose-graphs";
import { stressPoint } from "./layout";

/**
 * Animation area: a four-state Mannequin locomotion AnimationGraph driven by
 * a Class graph (Speed and Cheer variables), a rigid node-animated door and
 * the `FT_Stress` Mannequin crowd. Hierarchy Skeleton coverage comes from the
 * Basic 3D Mannequin import (the door Model has no Skeleton). `FT_Animation`
 * holds the skinned KayKit characters: Knight and Rogue Hooded share one
 * Skeleton and the clips of its animation libraries, under an Anim Graph that
 * blends two State Machines; Mannequin Large runs on its own Rig_Large Skeleton.
 */

/** Folder under `assets/FeatureTest/` for every animation asset. */
const FEATURE_TEST_ANIMATION_FOLDER = "Animation";

/** Asset names (Class ids are the file stems), so tests and docs can find them by path. */
const FEATURE_TEST_ANIMATION_NAMES = {
  /** Idle / Walk / Run / Cheer state machine on the Mannequin clips. */
  locomotionGraph: "FT_AnimLocomotion",
  /** Open / Close cycle on the Holiday Pack door's node animation clips. */
  doorGraph: "FT_AnimDoorSwing",
  /** Actor Class that drives the locomotion graph's variables every Tick. */
  locomotor: "FT_AnimLocomotor",
  /** Rig_Medium graph: Locomotion and Gestures State Machines, blended by Cheer in the Anim Graph. */
  adventurerGraph: "FT_AnimAdventurer",
  /** Rig_Large graph: one Move state blending Walk into Run by Speed. */
  largeGraph: "FT_AnimLargeMannequin",
  /** Locomotor Classes of the KayKit characters, one per Model. */
  knight: "FT_AnimKnight",
  rogue: "FT_AnimRogue",
  largeMannequin: "FT_AnimLargeMannequinActor",
} as const;

/** The skinned characters' scene. */
const ANIMATION_SCENE = "FT_Animation";
const SCENES_FOLDER = "Scenes";
const ANIMATION_SCENE_CAMERA = { position: [0, 2.2, -7] as Vec3, target: [0, 1, 0] as Vec3 };

/** KayKit clip names (Rig_Medium General and Movement Basic, Rig_Large Movement Basic). */
const KAYKIT_CLIPS = { idle: "Idle_A", walk: "Walking_A", run: "Running_A", interact: "Interact", pickUp: "PickUp" } as const;

/**
 * Perf knob: the `FT_Stress` crowd is `columns × rows` (64) Locomotor
 * Mannequins, each running one Class Tick and one Anim Graph evaluation.
 */
const FEATURE_TEST_ANIMATION_STRESS = { columns: 8, rows: 8, spacing: 2.75 } as const;

const NAMES = FEATURE_TEST_ANIMATION_NAMES;
const FOLDER = FEATURE_TEST_ANIMATION_FOLDER;

/** Speed = AMPLITUDE × (1 − cos(CycleRate × (Elapsed + Phase))), so 0 … 2 × AMPLITUDE. */
const SPEED_AMPLITUDE = 1.5;
/** Radians per second; one full idle → run → idle cycle takes 2π / rate ≈ 15.7 s. */
const CYCLE_RATE = 0.4;
const CYCLE_SECONDS = (2 * Math.PI) / CYCLE_RATE;
const WALK_SPEED = 0.5;
const RUN_SPEED = 2;
/** The Class raises Cheer while Speed is below this (about 1.8 s around each standstill). */
const CHEER_BELOW_SPEED = 0.1;

/** Mannequin clip names (`static`, `idle`, `walk`, `sprint`, `emote-yes`, …) used by the graph. */
const MANNEQUIN_CLIPS = { idle: "idle", walk: "walk", run: "sprint", cheer: "emote-yes" } as const;

/** Main-scene Locomotor slots (zone-local x, z); phases spread evenly over one cycle. */
const SHOWCASE_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [-9, -3],
  [-5.5, -3],
  [-2, -3],
  [-9, 2],
  [-5.5, 2],
  [-2, 2],
];

const DOOR_SCALE = 2.5;
/** The door's Open Animation has an authored Duration this many times its clip length, so it opens slower than it closes. */
const DOOR_OPEN_DURATION_SCALE = 1.5;

const SPEED: AnimGraphVariable = { id: "ft-anim-var-speed", name: "Speed", typeId: "float", defaultValue: 0 };
const CHEER: AnimGraphVariable = { id: "ft-anim-var-cheer", name: "Cheer", typeId: "bool", defaultValue: false };

/** A Class plus the prefab components its scene instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

interface AnimationRefs {
  locomotor: PlacedClass;
  doorGraph: string;
  /** The KayKit characters' Classes. */
  characters: { knight: PlacedClass; rogue: PlacedClass; largeMannequin: PlacedClass };
}

const refsByContext = new WeakMap<FeatureTestContext, AnimationRefs>();

/**
 * Create the Mannequin locomotion AnimationGraph, the door AnimationGraph and
 * the `FT_AnimLocomotor` Class (Mannequin Model + Anim Graph component; Tick
 * writes the graph's Speed and Cheer variables).
 */
export async function buildFeatureTestAnimation(ctx: FeatureTestContext): Promise<void> {
  await authorDoorOpenDuration(ctx);
  const locomotionGraph = await saveGraph(ctx, locomotionGraphDocument(ctx));
  const doorGraph = await saveGraph(ctx, doorGraphDocument(ctx));
  const mannequin = requireRef(ctx.assets.mannequin.modelGuid, "the Mannequin Model");
  const locomotor = await saveLocomotor(ctx, NAMES.locomotor, mannequin, locomotionGraph);
  const kaykit = ctx.assets.kaykit;
  const adventurerGraph = await saveGraph(ctx, adventurerGraphDocument(ctx));
  const largeGraph = await saveGraph(ctx, largeMannequinGraphDocument(ctx));
  const characters = {
    knight: await saveLocomotor(ctx, NAMES.knight, requireRef(kaykit.knight, "the KayKit Knight Model"), adventurerGraph),
    rogue: await saveLocomotor(ctx, NAMES.rogue, requireRef(kaykit.rogueHooded, "the KayKit Rogue Hooded Model"), adventurerGraph),
    largeMannequin: await saveLocomotor(
      ctx,
      NAMES.largeMannequin,
      requireRef(kaykit.mannequinLarge, "the KayKit Mannequin Large Model"),
      largeGraph,
    ),
  };
  refsByContext.set(ctx, { locomotor, doorGraph, characters });
}

/**
 * `Animation` zone: floor, six Locomotor Mannequins with staggered phases,
 * the swinging door and captions. `FT_Stress` (`animation` region) gets the
 * deterministic crowd grid.
 */
export async function placeFeatureTestAnimation(ctx: FeatureTestContext): Promise<void> {
  const refs = refsByContext.get(ctx);
  if (!refs) throw new Error("FeatureTest animation assets must be built before placement.");
  const zone = ctx.zone("animation");
  const add = (next: SerializedActor) => ctx.addActor(next, { zone: "animation" });
  zone.floor();

  SHOWCASE_SLOTS.forEach(([x, z], index) => {
    const phase = roundTo((index * CYCLE_SECONDS) / SHOWCASE_SLOTS.length, 100);
    const id = `ft-anim-locomotor-${index + 1}`;
    add(locomotorActor(refs.locomotor, id, `Locomotion Mannequin ${index + 1}`, zone.at(x, 0, z), phase));
  });

  const doorModel = requireRef(ctx.assets.models["cabin-door-rotate"], "the cabin-door-rotate Model");
  add(actor("ft-anim-door", "Swinging Door", tf(zone.at(7, 0, 0), { scale: [DOOR_SCALE, DOOR_SCALE, DOOR_SCALE] }), [
    meshComp("ft-anim-door-mesh", "box", { assetGuid: doorModel }),
    comp("ft-anim-door-graph", "AnimationGraphComponent", { graphGuid: refs.doorGraph }),
  ]));

  const font = ctx.assets.fonts.facetype || null;
  add(caption("ft-anim-caption-locomotion", "Locomotion Caption", zone.at(-5.5, 0.3, -7), "Idle Walk Run Cheer", font));
  add(caption("ft-anim-caption-door", "Door Caption", zone.at(7, 0.3, -7), "Node Animation Door", font));

  const { columns, rows, spacing } = FEATURE_TEST_ANIMATION_STRESS;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const x = (column - (columns - 1) / 2) * spacing;
      const z = (row - (rows - 1) / 2) * spacing;
      const phase = roundTo(((index % 16) * CYCLE_SECONDS) / 16, 100);
      const id = `ft-anim-stress-${index + 1}`;
      const position = stressPoint("animation", [x, 0, z]);
      ctx.addActor(locomotorActor(refs.locomotor, id, `Crowd Mannequin ${index + 1}`, position, phase), {
        scene: ctx.stressScene,
      });
    }
  }
  await placeAnimationScene(ctx, refs, font);
}

/**
 * `FT_Animation`: the skinned KayKit characters on a floor, facing the camera. Knight and Rogue Hooded run the
 * same graph half a cycle apart; Mannequin Large runs its Rig_Large graph.
 */
async function placeAnimationScene(ctx: FeatureTestContext, refs: AnimationRefs, font: string | null): Promise<void> {
  const scene: SerializedScene = createDefaultScene("3d");
  scene.name = ANIMATION_SCENE;
  scene.actors = scene.actors.filter((entry) => entry.components.length > 0);
  const camera = scene.actors.find((entry) => entry.id === scene.settings.defaultCameraActorId);
  if (camera) {
    camera.transform = tf(ANIMATION_SCENE_CAMERA.position, {
      rotation: lookAtRotation(ANIMATION_SCENE_CAMERA.position, ANIMATION_SCENE_CAMERA.target),
    });
  }
  const add = (entry: SerializedActor) => ctx.addActor(entry, { scene });
  // Box primitives are 1.5 m; the floor is 12 × 8 m.
  add(actor("ft-animscene-floor", "Floor", tf([0, -0.1, 1], { scale: [12 / 1.5, 0.2 / 1.5, 8 / 1.5] }), [
    meshComp("ft-animscene-floor-mesh", "box", { collision: "simple" }),
  ]));
  // Facing the camera: a half turn about Y.
  const facing = { rotationDeg: [0, 180, 0] as Vec3 };
  const place = (placed: PlacedClass, id: string, name: string, x: number, phase: number) =>
    add(actor(id, name, tf([x, 0, 0], facing), instanceComponents(id, placed.components), {
      classId: placed.ref.classId,
      properties: { Phase: phase },
    }));
  place(refs.characters.knight, "ft-animscene-knight", "Knight", -2.5, 0);
  place(refs.characters.rogue, "ft-animscene-rogue", "Rogue Hooded", 0, roundTo(CYCLE_SECONDS / 2, 100));
  place(refs.characters.largeMannequin, "ft-animscene-large", "Mannequin Large", 2.5, roundTo(CYCLE_SECONDS / 4, 100));
  add(caption("ft-animscene-caption-shared", "Shared Skeleton Caption", [-1.25, 0.05, -1.6], "Shared Skeleton", font, 0.35));
  add(caption("ft-animscene-caption-large", "Rig_Large Caption", [2.5, 0.05, -1.6], "Rig_Large", font, 0.35));
  await ctx.addSceneDocument({ kind: "scene", folder: SCENES_FOLDER, name: ANIMATION_SCENE, content: scene, order: SCENE_SAVE_ORDER.scene });
}

/** Save the door's Open Animation with a Duration longer than its clip, as the Inspector's Duration field does. */
async function authorDoorOpenDuration(ctx: FeatureTestContext): Promise<void> {
  const guid = ctx.assets.doorAnimations.open;
  const asset = guid ? ctx.registry.getByGuid(guid) : undefined;
  if (!asset) return;
  const payload = normalizeAnimationPayload(asset.header.payload);
  if (payload.clipDurationMs === undefined) return;
  await ctx.host.saveDocument("animation", asset.path, {
    ...payload,
    durationMs: payload.clipDurationMs * DOOR_OPEN_DURATION_SCALE,
  });
}

// ---------------------------------------------------------------------------
// Anim Graph documents

async function saveGraph(ctx: FeatureTestContext, doc: AnimGraphDocument): Promise<string> {
  const errors = validateAnimGraph(doc, animClipCatalogFromAssets(ctx.registry.list()), { dimension: "3d" }).filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(`FeatureTest Anim Graph "${doc.name}": ${errors.map((error) => error.message).join("; ")}`);
  }
  return (await ctx.createAsset("AnimationGraph3D", FOLDER, doc.name, { payload: doc as unknown as Record<string, unknown> }))
    .guid;
}

/**
 * Idle ⇄ Walk ⇄ Run on Speed thresholds, plus Idle → Cheer (non-looping
 * `emote-yes`) at an idle loop boundary while Cheer is set, and back when the
 * clip finishes. Every condition drives Enter State; Exit State stays unwired
 * (true), so one-way and Both Ways transitions behave the same.
 */
function locomotionGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const clip = (name: string) =>
    animationClip(ctx, requireRef(ctx.assets.mannequin.animations[name], `the Mannequin "${name}" Animation`));
  const speed = animGraphMembersFromVariables([SPEED])[0]!;
  const cheer = animGraphMembersFromVariables([CHEER])[0]!;
  // Run blends Walk into Sprint as Speed climbs past Run Speed: Alpha = Speed - (Run Speed - 1), clamped by Blend.
  const run: AnimState = {
    id: "run",
    name: "Run",
    position: { x: 720, y: 220 },
    stateGraph: poseGraph("3d", "blend", [
      playerNode("3d", "walk", 60, 40, clip(MANNEQUIN_CLIPS.walk)),
      playerNode("3d", "sprint", 60, 220, clip(MANNEQUIN_CLIPS.run)),
      getVar("get-speed", speed, -260, 400),
      gNode("speed-over-walk", "math.sub", 60, 400, { "default:b": RUN_SPEED - 1 }),
      gNode("blend", "anim.pose.blend", 500, 120),
    ], [
      gWire("walk", "pose", "blend", "a"),
      gWire("sprint", "pose", "blend", "b"),
      gWire("get-speed", "value", "speed-over-walk", "a"),
      gWire("speed-over-walk", "out", "blend", "alpha"),
    ]),
  };
  // Cheer plays its emote while Cheer is set and settles to the rest pose otherwise.
  const cheerState: AnimState = {
    id: "cheer",
    name: "Cheer",
    position: { x: 80, y: 480 },
    stateGraph: poseGraph("3d", "cheer-or-rest", [
      playerNode("3d", "cheer", 60, 40, clip(MANNEQUIN_CLIPS.cheer), { loop: false }),
      gNode("rest", "anim.pose.restPose", 60, 220),
      getVar("get-cheer", cheer, 60, 360),
      gNode("cheer-or-rest", "anim.pose.blendByBool", 500, 120, { trueBlendSeconds: 0.1, falseBlendSeconds: 0.3 }),
    ], [
      gWire("cheer", "pose", "cheer-or-rest", "truePose"),
      gWire("rest", "pose", "cheer-or-rest", "falsePose"),
      gWire("get-cheer", "value", "cheer-or-rest", "active"),
    ]),
  };
  return singleMachineGraph("3d", {
    name: NAMES.locomotionGraph,
    skeletonGuid: requireRef(ctx.assets.mannequin.skeletonGuid, "the Mannequin Skeleton"),
    machineName: "Locomotion",
    entryStateId: "idle",
    states: [
      playerState("3d", "idle", "Idle", 80, 220, clip(MANNEQUIN_CLIPS.idle)),
      playerState("3d", "walk", "Walk", 400, 220, clip(MANNEQUIN_CLIPS.walk)),
      run,
      cheerState,
    ],
    variables: [SPEED, CHEER],
    // Idle → Walk wins over Idle → Cheer (lower priority number runs first).
    transitions: [
      transition("idle-to-walk", "idle", "walk", 0.25, 0, FORWARD, [compare(SPEED, "math.greaterEqual", WALK_SPEED)]),
      transition("walk-to-idle", "walk", "idle", 0.25, 0, BACKWARD, [compare(SPEED, "math.less", WALK_SPEED)]),
      transition("walk-to-run", "walk", "run", 0.2, 0, FORWARD, [compare(SPEED, "math.greaterEqual", RUN_SPEED)]),
      transition("run-to-walk", "run", "walk", 0.2, 0, BACKWARD, [compare(SPEED, "math.less", RUN_SPEED)]),
      transition("idle-to-cheer", "idle", "cheer", 0.15, 1, DOWNWARD, [flag(CHEER), exitTime(1)]),
      transition("cheer-to-idle", "cheer", "idle", 0.2, 0, UPWARD, [exitTime(1)]),
    ],
  });
}

/**
 * The door Model imports as a rigid node animation (no Skeleton). With its
 * `open` and `close` clips the graph cycles Open → Close at half speed; any
 * other clip set falls back to one looping state.
 */
function doorGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const clips = ctx.assets.doorAnimations;
  // The door is one animated mesh, so its Animations have no Skeleton and neither does the graph.
  const base = { name: NAMES.doorGraph, skeletonGuid: null, machineName: "Door", variables: [] };
  if (clips.open && clips.close) {
    const open = animationClip(ctx, clips.open);
    // Close picks pose 0 (its clip) through Blend Poses By Int; pose 1 holds the open door with a Sequence Evaluator.
    const close: AnimState = {
      id: "close",
      name: "Close",
      position: { x: 400, y: 220 },
      stateGraph: poseGraph("3d", "pick", [
        playerNode("3d", "close", 60, 40, animationClip(ctx, clips.close), { loop: false, playRate: 0.5 }),
        { ...gNode("held-open", "anim.pose.sequenceEvaluator", 60, 220, { assetGuid: open.assetGuid, clipName: open.clipName, durationMs: open.durationMs }) },
        gNode("pick", "anim.pose.blendByInt", 500, 120, { count: 2, blendSeconds: 0.1 }),
      ], [
        gWire("close", "pose", "pick", "pose0"),
        gWire("held-open", "pose", "pick", "pose1"),
      ]),
    };
    return singleMachineGraph("3d", {
      ...base,
      entryStateId: "open",
      states: [playerState("3d", "open", "Open", 80, 220, open, { loop: false, playRate: 0.5 }), close],
      // Non-looping states: Exit Time 1 passes once the clip has finished.
      transitions: [
        transition("open-to-close", "open", "close", 0.1, 0, FORWARD, [exitTime(1)]),
        transition("close-to-open", "close", "open", 0.1, 0, BACKWARD, [exitTime(1)]),
      ],
    });
  }
  const swing = requireRef(clips["open-and-close"] ?? Object.values(clips)[0], "a cabin-door-rotate Animation");
  return singleMachineGraph("3d", {
    ...base,
    entryStateId: "swing",
    states: [playerState("3d", "swing", "Swing", 80, 220, animationClip(ctx, swing))],
    transitions: [],
  });
}

/** A KayKit rig's Animation, by clip name. */
function kaykitClip(ctx: FeatureTestContext, animations: Record<string, string>, name: string): FeatureTestClip {
  return animationClip(ctx, requireRef(animations[name], `the KayKit "${name}" Animation`));
}

/** Move state: Walk blended into Run as Speed climbs past Run Speed (Alpha = Speed - (Run Speed - 1)). */
function moveState(walk: FeatureTestClip, run: FeatureTestClip, x: number): AnimState {
  const speed = animGraphMembersFromVariables([SPEED])[0]!;
  return {
    id: "move",
    name: "Move",
    position: { x, y: 220 },
    stateGraph: poseGraph("3d", "blend", [
      playerNode("3d", "walk", 60, 40, walk),
      playerNode("3d", "run", 60, 220, run),
      getVar("get-speed", speed, -260, 400),
      gNode("speed-over-walk", "math.sub", 60, 400, { "default:b": RUN_SPEED - 1 }),
      gNode("blend", "anim.pose.blend", 500, 120),
    ], [
      gWire("walk", "pose", "blend", "a"),
      gWire("run", "pose", "blend", "b"),
      gWire("get-speed", "value", "speed-over-walk", "a"),
      gWire("speed-over-walk", "out", "blend", "alpha"),
    ]),
  };
}

/**
 * Rig_Medium: the Anim Graph blends a Locomotion State Machine (Idle ⇄ Move on Speed) with a Gestures State
 * Machine (Interact → Pick Up → Interact) by Cheer, through Blend Poses By Bool. Locomotion is first, so it is the
 * primary State Machine.
 */
function adventurerGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const animations = ctx.assets.kaykit.mediumAnimations;
  const clip = (name: string) => kaykitClip(ctx, animations, name);
  const cheer = animGraphMembersFromVariables([CHEER])[0]!;
  return {
    name: NAMES.adventurerGraph,
    skeletonGuid: requireRef(ctx.assets.kaykit.mediumSkeleton, "the KayKit Rig_Medium Skeleton"),
    variables: [SPEED, CHEER],
    animGraph: poseGraph("3d", "gesture-or-move", [
      gNode("gesture-or-move", "anim.pose.blendByBool", 500, 120, { trueBlendSeconds: 0.3, falseBlendSeconds: 0.3 }),
      gNode("machine-locomotion", "anim.pose.stateMachine", 60, 220, { machineId: "locomotion" }),
      gNode("machine-gestures", "anim.pose.stateMachine", 60, 40, { machineId: "gestures" }),
      getVar("get-cheer", cheer, 60, 400),
    ], [
      gWire("machine-gestures", "pose", "gesture-or-move", "truePose"),
      gWire("machine-locomotion", "pose", "gesture-or-move", "falsePose"),
      gWire("get-cheer", "value", "gesture-or-move", "active"),
    ]),
    stateMachines: [
      {
        id: "locomotion",
        name: "Locomotion",
        entryStateId: "idle",
        states: [
          playerState("3d", "idle", "Idle", 80, 220, clip(KAYKIT_CLIPS.idle)),
          moveState(clip(KAYKIT_CLIPS.walk), clip(KAYKIT_CLIPS.run), 400),
        ],
        transitions: [
          transition("adventurer-idle-to-move", "idle", "move", 0.25, 0, FORWARD, [compare(SPEED, "math.greaterEqual", WALK_SPEED)]),
          transition("adventurer-move-to-idle", "move", "idle", 0.25, 0, BACKWARD, [compare(SPEED, "math.less", WALK_SPEED)]),
        ],
      },
      {
        id: "gestures",
        name: "Gestures",
        entryStateId: "interact",
        states: [
          playerState("3d", "interact", "Interact", 80, 220, clip(KAYKIT_CLIPS.interact), { loop: false }),
          playerState("3d", "pick-up", "Pick Up", 400, 220, clip(KAYKIT_CLIPS.pickUp), { loop: false }),
        ],
        // Non-looping states: Exit Time 1 passes once the clip has finished.
        transitions: [
          transition("adventurer-interact-to-pick-up", "interact", "pick-up", 0.2, 0, FORWARD, [exitTime(1)]),
          transition("adventurer-pick-up-to-interact", "pick-up", "interact", 0.2, 0, BACKWARD, [exitTime(1)]),
        ],
      },
    ],
    animationObject: createDefaultAnimationObjectGraph(),
  };
}

/** Rig_Large: its library has walking and running only, so one Move state blends them by Speed. */
function largeMannequinGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const animations = ctx.assets.kaykit.largeAnimations;
  const clip = (name: string) => kaykitClip(ctx, animations, name);
  return singleMachineGraph("3d", {
    name: NAMES.largeGraph,
    skeletonGuid: requireRef(ctx.assets.kaykit.largeSkeleton, "the KayKit Rig_Large Skeleton"),
    machineName: "Locomotion",
    entryStateId: "move",
    states: [moveState(clip(KAYKIT_CLIPS.walk), clip(KAYKIT_CLIPS.run), 80)],
    transitions: [],
    variables: [SPEED, CHEER],
  });
}

/** An Animation's clip name and length as imported (Play re-resolves both from the catalog). */
function animationClip(ctx: FeatureTestContext, guid: string): FeatureTestClip {
  const asset = ctx.registry.getByGuid(guid);
  if (!asset || asset.header.type !== "Animation") throw new Error(`FeatureTest Animation ${guid} is missing.`);
  const payload = normalizeAnimationPayload(asset.header.payload);
  return { assetGuid: guid, clipName: payload.clipName, durationMs: payload.durationMs ?? 1000 };
}

type RuleTerm =
  | { kind: "compare"; variable: AnimGraphVariable; op: "math.greaterEqual" | "math.less"; value: number }
  | { kind: "flag"; variable: AnimGraphVariable }
  | { kind: "exitTime"; exitTime: number };

function compare(variable: AnimGraphVariable, op: "math.greaterEqual" | "math.less", value: number): RuleTerm {
  return { kind: "compare", variable, op, value };
}

function flag(variable: AnimGraphVariable): RuleTerm {
  return { kind: "flag", variable };
}

function exitTime(value: number): RuleTerm {
  return { kind: "exitTime", exitTime: value };
}

/** Canvas handles (`<side>-out` → `<side>-in`) for each transition direction. */
const FORWARD = ["right-out", "left-in"] as const;
const BACKWARD = ["left-out", "right-in"] as const;
const DOWNWARD = ["bottom-out", "top-in"] as const;
const UPWARD = ["top-out", "bottom-in"] as const;

function transition(
  id: string,
  fromStateId: string,
  toStateId: string,
  blendSeconds: number,
  priority: number,
  [sourceHandle, targetHandle]: readonly [string, string],
  terms: readonly RuleTerm[],
): AnimTransition {
  return { id, fromStateId, toStateId, blendSeconds, priority, ruleGraph: ruleGraph(terms), sourceHandle, targetHandle };
}

/** Terms AND-ed left to right into Enter State. */
function ruleGraph(terms: readonly RuleTerm[]): SerializedGraph {
  const graph = createDefaultTransitionRuleGraph();
  const outputs: Array<{ node: string; pin: string }> = [];
  terms.forEach((term, index) => {
    const y = 40 + index * 140;
    if (term.kind === "exitTime") {
      const id = `exit-time-${index}`;
      graph.nodes.push(gNode(id, ANIM_EXIT_TIME_REACHED_TYPE, 0, y, { title: "Exit Time Reached", exitTime: term.exitTime }));
      outputs.push({ node: id, pin: "value" });
      return;
    }
    const member = animGraphMembersFromVariables([term.variable])[0]!;
    const getId = `get-${index}`;
    graph.nodes.push(getVar(getId, member, -200, y));
    if (term.kind === "flag") {
      outputs.push({ node: getId, pin: "value" });
      return;
    }
    const compareId = `compare-${index}`;
    graph.nodes.push(gNode(compareId, term.op, 0, y, { "default:b": term.value }));
    graph.edges.push(gWire(getId, "value", compareId, "a"));
    outputs.push({ node: compareId, pin: "out" });
  });
  let result = outputs[0];
  if (!result) throw new Error("FeatureTest transition rules need at least one term.");
  for (let index = 1; index < outputs.length; index += 1) {
    const andId = `and-${index}`;
    const next = outputs[index]!;
    graph.nodes.push(gNode(andId, "boolean.and", 180, 40 + index * 100, { title: "And Bool" }));
    graph.edges.push(gWire(result.node, result.pin, andId, "a"), gWire(next.node, next.pin, andId, "b"));
    result = { node: andId, pin: "out" };
  }
  graph.edges.push(gWire(result.node, result.pin, ANIM_RULE_ENTER_NODE_ID, "value"));
  return graph;
}

// ---------------------------------------------------------------------------
// Locomotor Class

/**
 * Tick: Elapsed += Δt; Speed = 1.5 × (1 − cos(CycleRate × (Elapsed + Phase)));
 * Set Anim Graph Variable Speed, then Cheer = Speed < 0.1. The graph component
 * is found by class (Get Component Ref), so instance component ids never matter.
 */
async function saveLocomotor(ctx: FeatureTestContext, name: string, modelGuid: string, graphGuid: string): Promise<PlacedClass> {
  const elapsed = varMember("ft-anim-var-elapsed", "Elapsed", "float", 0, { category: "Locomotion" });
  const phase = varMember("ft-anim-var-phase", "Phase", "float", 0, { category: "Locomotion" });
  const cycleRate = varMember("ft-anim-var-cycle-rate", "CycleRate", "float", CYCLE_RATE, { category: "Locomotion" });
  const components: SerializedComponent[] = [
    meshComp("prefab-mesh", "box", { assetGuid: modelGuid }),
    comp("prefab-anim-graph", "AnimationGraphComponent", { graphGuid }),
  ];
  const graph = classGraph({
    members: [elapsed, phase, cycleRate],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      getVar("get-elapsed", elapsed, 0, 160),
      gNode("advance", "math.add", 240, 120),
      setVar("set-elapsed", elapsed, 480, 0),
      getVar("get-phase", phase, 480, 240),
      gNode("shifted", "math.add", 720, 200),
      getVar("get-cycle-rate", cycleRate, 720, 340),
      gNode("angle", "math.mul", 960, 240),
      gNode("cosine", "math.cos", 1180, 240),
      gNode("swing", "math.mul", 1400, 240, { "default:b": -SPEED_AMPLITUDE }),
      gNode("speed", "math.add", 1620, 240, { "default:b": SPEED_AMPLITUDE }),
      gNode("anim-graph", "component.getNamed", 1620, 440, {
        componentClassId: "AnimationGraphComponent",
        implicitSelf: true,
      }),
      gNode("set-speed", "anim.actor.setVariable", 1880, 0, { "default:name": SPEED.name }),
      gNode("calm", "math.less", 1880, 280, { "default:b": CHEER_BELOW_SPEED }),
      gNode("set-cheer", "anim.actor.setVariable", 2140, 0, { "default:name": CHEER.name }),
    ],
    edges: [
      gExec("tick", "set-elapsed"),
      ...gChain("set-elapsed", "set-speed", "set-cheer"),
      gWire("get-elapsed", "value", "advance", "a"),
      gWire("tick", "deltaSeconds", "advance", "b"),
      gWire("advance", "out", "set-elapsed", "value"),
      gWire("set-elapsed", "out", "shifted", "a"),
      gWire("get-phase", "value", "shifted", "b"),
      gWire("shifted", "out", "angle", "a"),
      gWire("get-cycle-rate", "value", "angle", "b"),
      gWire("angle", "out", "cosine", "in"),
      gWire("cosine", "out", "swing", "a"),
      gWire("swing", "out", "speed", "a"),
      gWire("anim-graph", "out", "set-speed", "target"),
      gWire("speed", "out", "set-speed", "value"),
      gWire("speed", "out", "calm", "a"),
      gWire("anim-graph", "out", "set-cheer", "target"),
      gWire("calm", "out", "set-cheer", "value"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name, parentClass: "Actor", graph });
  return { ref, components };
}

// ---------------------------------------------------------------------------
// Actors

/** Locomotor instance with a per-instance Phase (seconds) override. */
function locomotorActor(placed: PlacedClass, id: string, name: string, position: Vec3, phase: number): SerializedActor {
  return actor(id, name, tf(position), instanceComponents(id, placed.components), {
    classId: placed.ref.classId,
    properties: { Phase: phase },
  });
}

function caption(id: string, name: string, position: Vec3, text: string, fontAssetGuid: string | null, size = 0.5): SerializedActor {
  return actor(id, name, tf(position), [
    comp(`${id}-text`, "Text3DComponent", {
      text,
      size,
      color: [0.9, 0.9, 0.95],
      alignment: "center",
      fontAssetGuid,
    }),
  ]);
}

function roundTo(value: number, steps: number): number {
  return Math.round(value * steps) / steps;
}
