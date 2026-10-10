import {
  defaultPropertiesForClassId,
  validateBehaviourTree,
  type BehaviourTreeDocument,
  type BlackboardDocument,
  type BtAbortMode,
  type BtDecorator,
  type BtNode,
  type BtNodeKind,
  type BtService,
} from "@babylonslate/behaviour-tree";
import {
  composeAffineTransform,
  identitySerializedTransform,
  multiplyAffineTransforms,
  type AffineTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
  type Transform,
} from "@babylonslate/core";
import {
  mergeNavBakeMeshes,
  parseNavMeshActorSettings,
  parseNavMeshSettings,
  solidBlockerMesh,
  staticBlockerBakeParts,
  type NavBakeBounds,
  type NavBakeMeshPart,
  type NavMeshGenerateInput,
} from "@babylonslate/navigation";
import {
  actor,
  comp,
  meshComp,
  requireRef,
  tf,
  type FeatureTestContext,
  type Vec3,
} from "./context";
import { classGraph, fnGraph, fnMember, gChain, gExec, gNode, gWire } from "./graph";
import { FEATURE_TEST_ZONES, zonePoint } from "./layout";

/**
 * AI area: Blackboards, Behaviour Trees using every built-in composite, task,
 * decorator and service plus custom BTTask / BTDecorator / BTService /
 * BTComposite Classes, and the `AI And Navigation` arena (baked NavMesh with
 * bake bounds, static / cost / dynamic NavMesh Blockers, crowd guards and a
 * Mannequin sentry on a tower).
 */

const FOLDER = "AI";
const ZONE = "ai" as const;

/** Asset and Class names (Class ids are the file stems). */
export const FEATURE_TEST_AI_NAMES = {
  guardBlackboard: "FT_AIGuardBlackboard",
  alertBlackboard: "FT_AIAlertBlackboard",
  patrolTree: "FT_AIPatrolTree",
  sentryTree: "FT_AISentryTree",
  rememberHomeTask: "FT_AIRememberHomeTask",
  reportTask: "FT_AIReportTask",
  groundedDecorator: "FT_AIGroundedDecorator",
  trackService: "FT_AITrackService",
  patrolSequence: "FT_AIPatrolSequence",
} as const;

const NAMES = FEATURE_TEST_AI_NAMES;

/** Blackboard keys shared by both Blackboards and both trees. */
const KEY = {
  homeSet: "homeSet",
  homePoint: "homePoint",
  patrolPoint: "patrolPoint",
  lastSeen: "lastSeen",
  alert: "alert",
  phase: "phase",
} as const;

// Workload knobs. Crowd agents are capped at 32 per navmesh; keep well below.
const GUARD_COUNT = 4;
const GUARD_SPACING = 1.5;
const GUARD_HOME_X = -8;
/** Each guard patrols to the mirror of its home across the barrier. */
const PATROL_LANE: Vec3 = [16, 0, 0];
const ACCEPT_RADIUS = 0.75;
const MOVE_TIME_LIMIT_MS = 20_000;
/** East-side rally point every alerted guard runs to (zone-local). */
const RALLY_POINT: Vec3 = [6, 0, 6];
const RALLY_ACCEPT_RADIUS = 3;
const RALLY_TIME_LIMIT_MS = 15_000;
const ALERT_COOLDOWN_MS = 12_000;
const TRACK_INTERVAL_MS = 500;
const GROUNDED_MIN_Y = -1;

// Arena geometry (zone-local meters). Boxes are 1.5 m primitives scaled by the actor.
const PRIMITIVE_BOX = 1.5;
const WALL = { thickness: 2, height: 2, length: 8, gap: 4 };
const TOWER: Vec3 = [-10, 0, -10];
const TOWER_SIZE: Vec3 = [1.2, 3, 1.2];
const BAKE_INSET = 0.25;
/** Below the tower top so the editor collector leaves the Mannequin sentry out, like this bake. */
const BAKE_MAX_Y = 2.5;
const BAKE_MIN_Y = -0.5;

/** Recast values proven on this barrier layout (`packages/navigation/src/cost-volume.test.ts`). */
const NAV_RECAST = {
  cellSize: 0.25,
  cellHeight: 0.25,
  maxEdgeLen: 2,
  maxSimplificationError: 0.3,
  minRegionArea: 2,
  mergeRegionArea: 4,
  walkableRadius: 0.3,
};

/** Mannequin clips tried, in order, for the sentry's Play Animation task. */
const SENTRY_CLIPS = ["emote-no", "emote-yes", "interact-right"];

interface AiRefs {
  guardBlackboard: string;
  alertBlackboard: string;
  patrolTree: string;
  sentryTree: string;
}

interface AiClassIds {
  rememberHomeTask: string;
  reportTask: string;
  groundedDecorator: string;
  trackService: string;
  patrolSequence: string;
}

const refsByContext = new WeakMap<FeatureTestContext, AiRefs>();

/**
 * Create the custom BT Classes, the guard and alert Blackboards, and the patrol
 * and sentry Behaviour Trees (Classes and Blackboards first so tree headers
 * resolve their class and Blackboard references).
 */
export async function buildFeatureTestAi(ctx: FeatureTestContext): Promise<void> {
  const classes = await saveBtClasses(ctx);
  const guardBoard = blackboardDocument(NAMES.guardBlackboard, { alert: false, phase: "idle" });
  const alertBoard = blackboardDocument(NAMES.alertBlackboard, { alert: true, phase: "alert" });
  const guardBlackboard = await saveDocumentAsset(ctx, "Blackboard", NAMES.guardBlackboard, guardBoard);
  const alertBlackboard = await saveDocumentAsset(ctx, "Blackboard", NAMES.alertBlackboard, alertBoard);

  const patrol = patrolTreeDocument(classes, guardBlackboard);
  assertValidTree(patrol, guardBoard);
  const patrolTree = await saveDocumentAsset(ctx, "BehaviourTree", NAMES.patrolTree, patrol);

  // The sentry tree links the alert Blackboard so it stays export-reachable.
  const sentry = sentryTreeDocument(alertBlackboard, {
    clipGuid: pickClip(ctx.assets.mannequin.animations, SENTRY_CLIPS),
    soundGuid: ctx.assets.audio.oneShot,
  });
  assertValidTree(sentry, alertBoard);
  const sentryTree = await saveDocumentAsset(ctx, "BehaviourTree", NAMES.sentryTree, sentry);

  refsByContext.set(ctx, { guardBlackboard, alertBlackboard, patrolTree, sentryTree });
}

/**
 * `AI And Navigation` zone: floor, a barrier with a center gap, the NavMesh
 * (bake bounds inside the zone, tile cache for dynamic obstacles), static /
 * cost / dynamic blockers with captions, four crowd guards and the sentry.
 */
export async function placeFeatureTestAi(ctx: FeatureTestContext): Promise<void> {
  const refs = refsByContext.get(ctx);
  if (!refs) throw new Error("FeatureTest AI assets must be built before placement.");
  const zone = ctx.zone(ZONE);
  const add = (next: SerializedActor) => ctx.addActor(next, { zone: ZONE });
  const { materials, mannequin, fonts } = ctx.assets;
  zone.floor();

  // Barrier along Z at the zone center: a 4 m gap in the middle, open ends at the zone edges.
  const wallZ = (WALL.gap + WALL.length) / 2;
  for (const [id, name, z] of [
    ["ft-ai-wall-north", "Arena Wall North", wallZ],
    ["ft-ai-wall-south", "Arena Wall South", -wallZ],
  ] as const) {
    add(
      actor(id, name, tf(zone.at(0, WALL.height / 2, z), { scale: boxScale([WALL.thickness, WALL.height, WALL.length]) }), [
        meshComp(`${id}-mesh`, "box", { collision: "simple", materialGuid: materials.surface ?? null }),
      ]),
    );
  }

  const [halfX, halfZ] = FEATURE_TEST_ZONES[ZONE].size.map((size) => size / 2 - BAKE_INSET) as [number, number];
  add(
    actor("ft-ai-navmesh", "Arena NavMesh", tf(zone.at(6, 0, -9)), [
      comp("ft-ai-navmesh-navmesh", "NavMeshComponent", {
        ...NAV_RECAST,
        tiled: true,
        // Tile cache: required for the dynamic unwalkable blocker to carve at runtime.
        supportDynamicObstacles: true,
        // The scaffold bake is authoritative; Bake NavMesh in Details re-bakes on demand.
        autoBakeOnSave: false,
        bakeBoundsEnabled: true,
        bakeBoundsMin: navPoint(zone.at(-halfX, BAKE_MIN_Y, -halfZ)),
        bakeBoundsMax: navPoint(zone.at(halfX, BAKE_MAX_Y, halfZ)),
        debugOverlay: false,
      }),
    ]),
  );

  const caption = (id: string, position: Vec3, text: string) =>
    add(
      actor(`${id}-caption`, `${text} Caption`, tf(position), [
        comp(`${id}-caption-text`, "Text3DComponent", {
          text,
          size: 0.4,
          color: [0.85, 0.93, 1],
          alignment: "center",
          fontAssetGuid: fonts.facetype || null,
        }),
      ]),
    );
  // Actor scale is the blocker size (full extents).
  const blocker = (id: string, name: string, center: Vec3, size: Vec3, properties: Record<string, unknown>) => {
    add(actor(id, name, tf(zone.at(...center), { scale: size }), [comp(`${id}-blocker`, "NavMeshBlockerComponent", properties)]));
    caption(id, zone.at(center[0], size[1] + 0.4, center[2]), name);
  };
  // Baked carve on the guards' way to the south end.
  blocker("ft-ai-block-static", "Static Blocker", [-4.5, 1, -6], [1.5, 2, 1.5], {
    dynamic: false,
    kind: "box",
    area: "unwalkable",
  });
  // Detour area cost over the gap: guards walk around the barrier instead.
  blocker("ft-ai-block-cost", "Cost Volume", [0, 1, 0], [4, 2, 3], { dynamic: false, kind: "box", area: "cost", cost: 10 });
  // Tile-cache obstacle added at Play start: closes the north end.
  blocker("ft-ai-block-dynamic", "Dynamic Blocker", [0, 1, 10.9], [2, 2, 2.2], {
    dynamic: true,
    kind: "box",
    area: "unwalkable",
  });

  for (let index = 0; index < GUARD_COUNT; index += 1) {
    const n = index + 1;
    const id = `ft-ai-guard-${n}`;
    // Odd guards override the tree's Blackboard with the alert Blackboard.
    const alerted = index % 2 === 1;
    const z = (index - (GUARD_COUNT - 1) / 2) * GUARD_SPACING;
    add(
      actor(id, alerted ? `Alerted Guard ${n}` : `Patrol Guard ${n}`, tf(zone.at(GUARD_HOME_X, 0, z)), [
        {
          ...meshComp(`${id}-body`, "cylinder", {
            materialGuid: (alerted ? materials.surfaceInstance : materials.surface) ?? null,
          }),
          // Primitives are centered; the crowd keeps the actor origin on the navmesh.
          transform: tf([0, 0.75, 0], { scale: [0.9, 1, 0.9] }),
        },
        {
          ...meshComp(`${id}-visor`, "box", { materialGuid: materials.emissive ?? null }),
          transform: tf([0, 1.2, 0.4], { scale: [0.4, 0.12, 0.2] }),
        },
        comp(`${id}-agent`, "NavAgentComponent", { radius: 0.45, height: 1.6, maxSpeed: 3, maxAcceleration: 8 }),
        comp(`${id}-brain`, "BehaviourTreeComponent", {
          treeGuid: refs.patrolTree,
          // Always explicit: editor Play loads only component-referenced Blackboards.
          blackboardGuid: alerted ? refs.alertBlackboard : refs.guardBlackboard,
        }),
      ]),
    );
  }

  add(
    actor("ft-ai-sentry-tower", "Sentry Tower", tf(zone.at(TOWER[0], TOWER_SIZE[1] / 2, TOWER[2]), { scale: boxScale(TOWER_SIZE) }), [
      meshComp("ft-ai-sentry-tower-mesh", "box", { collision: "simple" }),
    ]),
  );
  add(
    actor("ft-ai-sentry", "Sentry", tf(zone.at(TOWER[0], TOWER_SIZE[1], TOWER[2]), { rotationDeg: [0, 45, 0] }), [
      meshComp("ft-ai-sentry-mesh", "box", { assetGuid: requireRef(mannequin.modelGuid, "the Mannequin Model") }),
      comp("ft-ai-sentry-anim", "AnimationGraphComponent", {
        graphGuid: requireRef(mannequin.idleGraphGuid, "the Mannequin idle Animation Graph"),
      }),
      comp("ft-ai-sentry-brain", "BehaviourTreeComponent", {
        treeGuid: refs.sentryTree,
        blackboardGuid: refs.alertBlackboard,
      }),
    ]),
  );

  // Editor viewport overlay of the baked navmesh chunk (no Play cost).
  ctx.mainScene.settings.showNavmesh = true;
}

/**
 * Recast bake input for the arena, or null without a NavMeshComponent: the
 * same triangles the editor 3D collector gathers (primitive MeshComponent
 * world meshes whose AABB meets the bake bounds, then static unwalkable
 * blockers) and the same settings. Crowd agents (NavAgentComponent actors)
 * are left out so guards never carve their own spawn; model meshes are not
 * reproduced, so the arena keeps its Mannequin above the bake bounds.
 */
export function featureTestNavBakeInput(scene: SerializedScene): NavMeshGenerateInput | null {
  if (scene.viewportMode === "2d") return null;
  const navMesh = scene.actors
    .flatMap((entry) => entry.components)
    .find((component) => component.classId === "NavMeshComponent");
  if (!navMesh) return null;
  const settings = parseNavMeshActorSettings(navMesh.properties);
  const bounds: NavBakeBounds | undefined = settings.bakeBoundsEnabled
    ? { min: settings.bakeBoundsMin, max: settings.bakeBoundsMax }
    : undefined;
  const actorsById = new Map<string, SerializedActor>(scene.actors.map((entry) => [entry.id, entry] as const));
  const parts: NavBakeMeshPart[] = [];
  for (const owner of scene.actors) {
    if (owner.components.some((component) => component.classId === "NavAgentComponent")) continue;
    for (const component of owner.components) {
      if (component.classId !== "MeshComponent" || component.properties.assetGuid) continue;
      const local = primitiveTriangles(component.properties.meshKind);
      if (!local) continue;
      const positions = transformPositions(local.positions, componentWorldMatrix(actorsById, owner, component));
      if (bounds && !intersectsBounds(positions, bounds)) continue;
      parts.push({ positions, indices: local.indices });
    }
  }
  if (parts.length === 0) return null;
  parts.push(...staticBlockerBakeParts(scene.actors, "3d", bounds));
  return {
    ...mergeNavBakeMeshes(parts),
    settings: { ...parseNavMeshSettings(navMesh.properties), supportDynamicObstacles: settings.supportDynamicObstacles },
  };
}

// ---------------------------------------------------------------------------
// Assets

async function saveDocumentAsset(
  ctx: FeatureTestContext,
  type: "Blackboard" | "BehaviourTree",
  name: string,
  document: BlackboardDocument | BehaviourTreeDocument,
): Promise<string> {
  const payload = document as unknown as Record<string, unknown>;
  return (await ctx.createAsset(type, FOLDER, name, { payload })).guid;
}

/** Same keys on both Blackboards; the alert Blackboard starts alerted. */
function blackboardDocument(name: string, defaults: { alert: boolean; phase: string }): BlackboardDocument {
  return {
    name,
    keys: [
      { name: KEY.homeSet, type: { kind: "bool" }, defaultValue: false },
      // Unset until FT_AIRememberHomeTask writes them: Move To Blackboard Key fails cleanly before that.
      { name: KEY.homePoint, type: { kind: "vec3" } },
      { name: KEY.patrolPoint, type: { kind: "vec3" } },
      { name: KEY.lastSeen, type: { kind: "vec3" } },
      { name: KEY.alert, type: { kind: "bool" }, defaultValue: defaults.alert },
      { name: KEY.phase, type: { kind: "string" }, defaultValue: defaults.phase },
    ],
  };
}

/** Editor diagnostics (canvas badges / Compiler Results) must stay clean. */
function assertValidTree(tree: BehaviourTreeDocument, blackboard: BlackboardDocument): void {
  const errors = validateBehaviourTree(tree, { assetGuid: tree.name, blackboardKeyEntries: blackboard.keys }).filter(
    (row) => row.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(`FeatureTest ${tree.name} is invalid: ${errors.map((row) => row.message).join("; ")}`);
  }
}

function pickClip(animations: Record<string, string>, names: readonly string[]): string | null {
  const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const wanted of names) {
    const found = Object.entries(animations).find(([clipName]) => simplify(clipName) === simplify(wanted));
    if (found) return found[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Behaviour Trees

type Attachments = { decorators?: BtDecorator[]; services?: BtService[] };

function btTask(id: string, classId: string, properties: Record<string, unknown> = {}, attach: Attachments = {}): BtNode {
  return {
    id,
    kind: "task",
    classId,
    children: [],
    decorators: attach.decorators ?? [],
    services: attach.services ?? [],
    properties: { ...defaultPropertiesForClassId(classId), ...properties },
  };
}

function btComposite(
  id: string,
  kind: Exclude<BtNodeKind, "task">,
  classId: string,
  children: string[],
  attach: Attachments = {},
): BtNode {
  return {
    id,
    kind,
    classId,
    children,
    decorators: attach.decorators ?? [],
    services: attach.services ?? [],
    properties: {},
  };
}

function btDecorator(
  id: string,
  classId: string,
  properties: Record<string, unknown> = {},
  abortMode: BtAbortMode = "none",
  observedKeys: string[] = [],
): BtDecorator {
  return { id, classId, abortMode, observedKeys, properties: { ...defaultPropertiesForClassId(classId), ...properties } };
}

/** Zero random deviation keeps the service schedule identical every run. */
function btService(id: string, classId: string, intervalMs: number, properties: Record<string, unknown> = {}): BtService {
  return {
    id,
    classId,
    intervalMs,
    randomDeviationMs: 0,
    properties: { ...defaultPropertiesForClassId(classId), ...properties },
  };
}

/**
 * Guard brain. Root selector (service: track position) → Setup once (custom
 * task records home and patrol points) → Alert (Blackboard Is Set, aborts
 * lower priority): clear, Move To the rally point, face the center, wait →
 * Patrol (custom composite; custom + compare decorators; Set Blackboard
 * service): Move To Blackboard Key out, wait, custom report, raise the alert
 * on a cooldown (the abort fires during Settle), move home, a finite Loop, a
 * Parallel with Fail / Succeed → Idle wait. Every move has a Time Limit.
 */
function patrolTreeDocument(classes: AiClassIds, blackboardGuid: string): BehaviourTreeDocument {
  const center = navPoint(zonePoint(ZONE, [0, 0, 0]));
  const rally = navPoint(zonePoint(ZONE, RALLY_POINT));
  const tower = navPoint(zonePoint(ZONE, TOWER));
  const timeLimit = (id: string) => btDecorator(id, "bt.decorator.timeLimit", { durationMs: MOVE_TIME_LIMIT_MS });
  const nodes: BtNode[] = [
    btComposite("root", "selector", "bt.composite.selector", ["setup", "alert", "patrol", "idle"], {
      services: [btService("track", classes.trackService, TRACK_INTERVAL_MS)],
    }),
    btComposite("setup", "sequence", "bt.composite.sequence", ["remember-home"], {
      decorators: [
        btDecorator("needs-home", "bt.decorator.compareBlackboardValue", { key: KEY.homeSet, op: "eq", value: false }),
      ],
    }),
    btTask("remember-home", classes.rememberHomeTask),
    // Clear first so a failed rally never leaves the alert stuck on.
    btComposite("alert", "sequence", "bt.composite.sequence", ["alert-clear", "alert-rally", "alert-face", "alert-hold"], {
      decorators: [
        btDecorator("alert-set", "bt.decorator.blackboardIsSet", { key: KEY.alert }, "lowerPriority", [KEY.alert]),
      ],
    }),
    btTask("alert-clear", "bt.task.setBlackboard", { key: KEY.alert, value: false }),
    // Shared fixed destination: the wide accept radius lets every guard arrive around it.
    btTask("alert-rally", "bt.task.moveTo", { destination: rally, acceptRadius: RALLY_ACCEPT_RADIUS }, {
      decorators: [btDecorator("alert-rally-limit", "bt.decorator.timeLimit", { durationMs: RALLY_TIME_LIMIT_MS })],
    }),
    btTask("alert-face", "bt.task.rotateToFace", { target: center }),
    btTask("alert-hold", "bt.task.wait", { durationMs: 800 }),
    btComposite(
      "patrol",
      "sequence",
      classes.patrolSequence,
      ["move-out", "pause", "report", "maybe-alert", "settle", "move-home", "scan", "fx"],
      {
        decorators: [
          btDecorator("grounded", classes.groundedDecorator),
          btDecorator(
            "not-blocked",
            "bt.decorator.compareBlackboardValue",
            { key: KEY.phase, op: "neq", value: "blocked" },
            "self",
            [KEY.phase],
          ),
        ],
        services: [btService("phase-patrol", "bt.service.setBlackboard", 1000, { key: KEY.phase, value: "patrol" })],
      },
    ),
    btTask("move-out", "bt.task.moveToBlackboardKey", { key: KEY.patrolPoint, acceptRadius: ACCEPT_RADIUS }, {
      decorators: [timeLimit("move-out-limit")],
    }),
    btTask("pause", "bt.task.wait", { durationMs: 400 }),
    btTask("report", classes.reportTask),
    btComposite("maybe-alert", "selector", "bt.composite.selector", ["raise-alert", "no-alert"]),
    btTask("raise-alert", "bt.task.setBlackboard", { key: KEY.alert, value: true }, {
      decorators: [btDecorator("alert-cooldown", "bt.decorator.cooldown", { durationMs: ALERT_COOLDOWN_MS })],
    }),
    btTask("no-alert", "bt.task.succeed"),
    // Latent step so the alert raised above aborts this lower-priority branch.
    btTask("settle", "bt.task.wait", { durationMs: 300 }),
    btTask("move-home", "bt.task.moveToBlackboardKey", { key: KEY.homePoint, acceptRadius: ACCEPT_RADIUS }, {
      decorators: [timeLimit("move-home-limit")],
    }),
    // Finite Loop around a latent Wait (never an infinite Loop of instant tasks).
    btComposite("scan", "sequence", "bt.composite.sequence", ["scan-face", "scan-wait"], {
      decorators: [btDecorator("scan-loop", "bt.decorator.loop", { numLoops: 3 })],
    }),
    btTask("scan-face", "bt.task.rotateToFace", { target: tower }),
    btTask("scan-wait", "bt.task.wait", { durationMs: 200 }),
    btComposite("fx", "parallel", "bt.composite.parallel", ["fx-wait", "fx-try"]),
    btTask("fx-wait", "bt.task.wait", { durationMs: 300 }),
    btComposite("fx-try", "selector", "bt.composite.selector", ["fx-fail", "fx-ok"]),
    btTask("fx-fail", "bt.task.fail"),
    btTask("fx-ok", "bt.task.succeed"),
    btTask("idle", "bt.task.wait", { durationMs: 500 }),
  ];
  return { name: NAMES.patrolTree, rootId: "root", blackboardGuid, nodes };
}

/**
 * Sentry brain: face the patrol side, hold, gesture (Play Animation on the
 * Mannequin, then Play Sound on a cooldown; a failing gesture falls through to
 * Succeed), face the guard homes, hold. Gesture steps exist only when the
 * Mannequin clip / optional one-shot Audio exist.
 */
function sentryTreeDocument(
  blackboardGuid: string,
  media: { clipGuid: string | null; soundGuid: string | null },
): BehaviourTreeDocument {
  const gesture: BtNode[] = [
    ...(media.clipGuid
      ? [btTask("gesture-anim", "bt.task.playAnimation", { clipKind: "animation", clipAssetGuid: media.clipGuid })]
      : []),
    ...(media.soundGuid
      ? [
          btTask("gesture-sound", "bt.task.playSound", { audioAssetGuid: media.soundGuid, volume: 0.4 }, {
            decorators: [btDecorator("sound-cooldown", "bt.decorator.cooldown", { durationMs: 10_000 })],
          }),
        ]
      : []),
  ];
  const gestureNodes: BtNode[] = gesture.length > 0
    ? [
        btComposite("gesture", "selector", "bt.composite.selector", ["gesture-play", "gesture-skip"]),
        btComposite("gesture-play", "sequence", "bt.composite.sequence", gesture.map((node) => node.id)),
        ...gesture,
        btTask("gesture-skip", "bt.task.succeed"),
      ]
    : [];
  const steps = ["face-patrol", "hold-patrol", ...(gesture.length > 0 ? ["gesture"] : []), "face-home", "hold-home"];
  return {
    name: NAMES.sentryTree,
    rootId: "watch",
    blackboardGuid,
    nodes: [
      btComposite("watch", "sequence", "bt.composite.sequence", steps, {
        services: [btService("phase-watch", "bt.service.setBlackboard", 1000, { key: KEY.phase, value: "watch" })],
      }),
      btTask("face-patrol", "bt.task.rotateToFace", {
        target: navPoint(zonePoint(ZONE, [GUARD_HOME_X + PATROL_LANE[0], 0, PATROL_LANE[2]])),
      }),
      btTask("hold-patrol", "bt.task.wait", { durationMs: 1500 }),
      ...gestureNodes,
      btTask("face-home", "bt.task.rotateToFace", { target: navPoint(zonePoint(ZONE, [GUARD_HOME_X, 0, 0])) }),
      btTask("hold-home", "bt.task.wait", { durationMs: 1500 }),
    ],
  };
}

// ---------------------------------------------------------------------------
// BT Classes (class ids are file stems; graphs validate like Play)

async function saveBtClasses(ctx: FeatureTestContext): Promise<AiClassIds> {
  const save = async (name: string, parentClass: string, graph: ReturnType<typeof classGraph>) =>
    (await ctx.saveClass({ folder: FOLDER, name, parentClass, graph })).classId;
  const zero = { x: 0, y: 0, z: 0 };

  // On Activate: home = own location, patrol point = home + lane, mark set, finish.
  const rememberHomeTask = await save(
    NAMES.rememberHomeTask,
    "BTTask",
    classGraph({
      nodes: [
        gNode("activate", "bt.event.activate", 0, 0),
        gNode("self", "actor.getSelf", 0, 220),
        gNode("location", "transform.getLocation", 220, 220),
        // Add Vector3 copies the live position so the key does not follow the actor.
        gNode("home", "vector.add3", 460, 160, { "default:b": zero }),
        gNode("patrol", "vector.add3", 460, 320, { "default:b": navPoint(PATROL_LANE) }),
        gNode("set-home", "bt.blackboard.set", 300, 0, { "default:key": KEY.homePoint }),
        gNode("set-patrol", "bt.blackboard.set", 580, 0, { "default:key": KEY.patrolPoint }),
        gNode("set-flag", "bt.blackboard.set", 860, 0, { "default:key": KEY.homeSet, "default:value": true }),
        gNode("finish", "bt.finish", 1140, 0, { "default:success": true }),
      ],
      edges: [
        ...gChain("activate", "set-home", "set-patrol", "set-flag", "finish"),
        gWire("self", "out", "location", "target"),
        gWire("location", "out", "home", "a"),
        gWire("location", "out", "patrol", "a"),
        gWire("home", "out", "set-home", "value"),
        gWire("patrol", "out", "set-patrol", "value"),
      ],
    }),
  );

  // Latent activation: Delay → Set Blackboard phase → Finish Execute; On Abort marks the phase.
  const reportTask = await save(
    NAMES.reportTask,
    "BTTask",
    classGraph({
      nodes: [
        gNode("activate", "bt.event.activate", 0, 0),
        gNode("delay", "timers.delay", 240, 0, { "default:duration": 0.3 }),
        gNode("set-phase", "bt.blackboard.set", 480, 0, { "default:key": KEY.phase, "default:value": "report" }),
        gNode("finish", "bt.finish", 760, 0, { "default:success": true }),
        gNode("abort", "bt.event.abort", 0, 240),
        gNode("abort-phase", "bt.blackboard.set", 240, 240, {
          "default:key": KEY.phase,
          "default:value": "interrupted",
        }),
      ],
      edges: [...gChain("activate", "delay", "set-phase", "finish"), gExec("abort", "abort-phase")],
    }),
  );

  // On Evaluate: pass while the owner stands above GROUNDED_MIN_Y.
  const groundedDecorator = await save(
    NAMES.groundedDecorator,
    "BTDecorator",
    classGraph({
      nodes: [
        gNode("evaluate", "bt.event.evaluate", 0, 0),
        gNode("self", "actor.getSelf", 0, 200),
        gNode("location", "transform.getLocation", 220, 200),
        gNode("split", "vector.break3", 460, 200),
        gNode("grounded", "math.greater", 680, 160, { "default:b": GROUNDED_MIN_Y }),
        gNode("return", "bt.returnCondition", 920, 0),
      ],
      edges: [
        gExec("evaluate", "return"),
        gWire("self", "out", "location", "target"),
        gWire("location", "out", "split", "in"),
        gWire("split", "y", "grounded", "a"),
        gWire("grounded", "out", "return", "condition"),
      ],
    }),
  );

  // On Tick (service interval): copy the owner's position into `lastSeen`.
  const trackService = await save(
    NAMES.trackService,
    "BTService",
    classGraph({
      nodes: [
        gNode("tick", "bt.event.tick", 0, 0),
        gNode("self", "actor.getSelf", 0, 200),
        gNode("location", "transform.getLocation", 220, 200),
        gNode("copy", "vector.add3", 460, 200, { "default:b": zero }),
        gNode("set-seen", "bt.blackboard.set", 300, 0, { "default:key": KEY.lastSeen }),
      ],
      edges: [
        gExec("tick", "set-seen"),
        gWire("self", "out", "location", "target"),
        gWire("location", "out", "copy", "a"),
        gWire("copy", "out", "set-seen", "value"),
      ],
    }),
  );

  // Data composite (sequence from ancestry, no script VM); Describe keeps it compiled.
  const describe = fnMember("ft-ai-fn-describe", "Describe", [{ name: "Label", typeId: "string", direction: "out" }]);
  const describeGraph = fnGraph(describe);
  for (const node of describeGraph.nodes) {
    if (node.id === `${describe.id}-output`) node.data["default:Label"] = "Patrol Sequence";
  }
  const patrolSequence = await save(
    NAMES.patrolSequence,
    "BTComposite",
    classGraph({ members: [describe], functionGraphs: { [describe.id]: describeGraph } }),
  );

  return { rememberHomeTask, reportTask, groundedDecorator, trackService, patrolSequence };
}

// ---------------------------------------------------------------------------
// Geometry helpers

function navPoint(value: readonly [number, number, number]): { x: number; y: number; z: number } {
  return { x: value[0], y: value[1], z: value[2] };
}

/** Actor scale for a 1.5 m box primitive of the given size. */
function boxScale(size: Vec3): Vec3 {
  return [size[0] / PRIMITIVE_BOX, size[1] / PRIMITIVE_BOX, size[2] / PRIMITIVE_BOX];
}

const ORIGIN = { x: 0, y: 0, z: 0 };

/**
 * Local triangles of a primitive MeshComponent (`createPrimitiveMesh` sizes),
 * wound for Recast. Box and ground match exactly; the cylinder is a 12-sided
 * approximation; sphere, plane and sprite-like kinds are not reproduced.
 */
function primitiveTriangles(meshKind: unknown): { positions: number[]; indices: number[] } | null {
  switch (meshKind) {
    case "ground":
      return { positions: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 3, 2, 0, 2, 1] };
    case "cylinder":
      return solidBlockerMesh({ kind: "cylinder", pose: ORIGIN, size: { x: 0.5, y: 1.5, z: 0.5 } });
    case "sphere":
    case "plane":
    case "quad":
    case "sprite":
    case "tilemap":
    case "pivot":
      return null;
    default:
      // `createPrimitiveMesh` draws a 1.5 m box for "box" and unknown kinds.
      return solidBlockerMesh({ kind: "box", pose: ORIGIN, size: { x: PRIMITIVE_BOX, y: PRIMITIVE_BOX, z: PRIMITIVE_BOX } });
  }
}

function toTransform(transform: SerializedTransform | undefined): Transform {
  const source = transform ?? identitySerializedTransform();
  const [px, py, pz] = source.position;
  const [rx, ry, rz, rw] = source.rotation;
  const [sx, sy, sz] = source.scale;
  return { position: { x: px, y: py, z: pz }, rotation: { x: rx, y: ry, z: rz, w: rw }, scale: { x: sx, y: sy, z: sz } };
}

/** Component → parent components → actor → parent actors, composed like Babylon parenting. */
function componentWorldMatrix(
  actorsById: ReadonlyMap<string, SerializedActor>,
  owner: SerializedActor,
  component: SerializedComponent,
): AffineTransform {
  let matrix = composeAffineTransform(toTransform(component.transform));
  const seenComponents = new Set([component.id]);
  let parentId = component.parentId ?? null;
  while (parentId && !seenComponents.has(parentId)) {
    seenComponents.add(parentId);
    const wanted = parentId;
    const parent = owner.components.find((entry) => entry.id === wanted);
    if (!parent) break;
    matrix = multiplyAffineTransforms(matrix, composeAffineTransform(toTransform(parent.transform)));
    parentId = parent.parentId ?? null;
  }
  const seenActors = new Set<string>();
  let current: SerializedActor | undefined = owner;
  while (current && !seenActors.has(current.id)) {
    seenActors.add(current.id);
    matrix = multiplyAffineTransforms(matrix, composeAffineTransform(toTransform(current.transform)));
    current = current.parentId ? actorsById.get(current.parentId) : undefined;
  }
  return matrix;
}

/** Row-vector affine (`AffineTransform` layout): p' = p × M. */
function transformPositions(local: readonly number[], m: AffineTransform): number[] {
  const out: number[] = [];
  for (let index = 0; index + 2 < local.length; index += 3) {
    const x = local[index]!;
    const y = local[index + 1]!;
    const z = local[index + 2]!;
    out.push(
      x * m[0]! + y * m[3]! + z * m[6]! + m[9]!,
      x * m[1]! + y * m[4]! + z * m[7]! + m[10]!,
      x * m[2]! + y * m[5]! + z * m[8]! + m[11]!,
    );
  }
  return out;
}

/** Inclusive AABB test, as the editor collector's bake-bounds filter. */
function intersectsBounds(positions: readonly number[], bounds: NavBakeBounds): boolean {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  const boundsMin = [bounds.min.x, bounds.min.y, bounds.min.z];
  const boundsMax = [bounds.max.x, bounds.max.y, bounds.max.z];
  for (let axis = 0; axis < 3; axis += 1) {
    const low = Math.min(boundsMin[axis]!, boundsMax[axis]!);
    const high = Math.max(boundsMin[axis]!, boundsMax[axis]!);
    if (min[axis]! > high || max[axis]! < low) return false;
  }
  return true;
}
