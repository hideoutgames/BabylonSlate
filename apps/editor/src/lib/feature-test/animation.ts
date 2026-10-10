import {
  ANIM_EXIT_TIME_REACHED_TYPE,
  ANIM_GRAPH_SCHEMA_VERSION,
  ANIM_RULE_ENTER_NODE_ID,
  animGraphMembersFromVariables,
  createDefaultAnimationObjectGraph,
  createDefaultTransitionRuleGraph,
  validateAnimGraph,
  type AnimClipRef,
  type AnimGraphDocument,
  type AnimGraphVariable,
  type AnimState,
  type AnimTransition,
} from "@babylonslate/anim-graph";
import { normalizeAnimationPayload } from "@babylonslate/assets";
import type { SerializedActor, SerializedComponent, SerializedGraph } from "@babylonslate/core";
import { animClipCatalogFromAssets } from "../anim-clip-catalog";
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
import { classGraph, gChain, gExec, getVar, gNode, gWire, setVar, varMember } from "./graph";
import { stressPoint } from "./layout";

/**
 * Animation area: a four-state Mannequin locomotion AnimationGraph driven by
 * a Class graph (Speed and Cheer variables), a rigid node-animated door and
 * the `FT_Stress` Mannequin crowd. Skeleton coverage comes from the Basic 3D
 * Mannequin import (the door Model has no Skeleton).
 */

/** Folder under `assets/FeatureTest/` for every animation asset. */
export const FEATURE_TEST_ANIMATION_FOLDER = "Animation";

/** Asset names (Class ids are the file stems), so tests and docs can find them by path. */
export const FEATURE_TEST_ANIMATION_NAMES = {
  /** Idle / Walk / Run / Cheer state machine on the Mannequin clips. */
  locomotionGraph: "FT_AnimLocomotion",
  /** Open / Close cycle on the Holiday Pack door's node animation clips. */
  doorGraph: "FT_AnimDoorSwing",
  /** Actor Class that drives the locomotion graph's variables every Tick. */
  locomotor: "FT_AnimLocomotor",
} as const;

/**
 * Perf knob: the `FT_Stress` crowd is `columns × rows` (64) Locomotor
 * Mannequins, each running one Class Tick and one Anim Graph evaluation.
 */
export const FEATURE_TEST_ANIMATION_STRESS = { columns: 8, rows: 8, spacing: 2.75 } as const;

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
}

const refsByContext = new WeakMap<FeatureTestContext, AnimationRefs>();

/**
 * Create the Mannequin locomotion AnimationGraph, the door AnimationGraph and
 * the `FT_AnimLocomotor` Class (Mannequin Model + Anim Graph component; Tick
 * writes the graph's Speed and Cheer variables).
 */
export async function buildFeatureTestAnimation(ctx: FeatureTestContext): Promise<void> {
  const locomotionGraph = await saveGraph(ctx, locomotionGraphDocument(ctx));
  const doorGraph = await saveGraph(ctx, doorGraphDocument(ctx));
  const locomotor = await saveLocomotor(ctx, locomotionGraph);
  refsByContext.set(ctx, { locomotor, doorGraph });
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
}

// ---------------------------------------------------------------------------
// Anim Graph documents

async function saveGraph(ctx: FeatureTestContext, doc: AnimGraphDocument): Promise<string> {
  const errors = validateAnimGraph(doc, animClipCatalogFromAssets(ctx.registry.list())).filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(`FeatureTest Anim Graph "${doc.name}": ${errors.map((error) => error.message).join("; ")}`);
  }
  return (await ctx.createAsset("AnimationGraph", FOLDER, doc.name, { payload: doc as unknown as Record<string, unknown> }))
    .guid;
}

/**
 * Idle ⇄ Walk ⇄ Run on Speed thresholds, plus Idle → Cheer (non-looping
 * `emote-yes`) at an idle loop boundary while Cheer is set, and back when the
 * clip finishes. Every condition drives Enter State; Exit State stays unwired
 * (true), so one-way and Both Ways transitions behave the same.
 */
function locomotionGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const clip = (id: string, name: string) =>
    animationClip(ctx, id, requireRef(ctx.assets.mannequin.animations[name], `the Mannequin "${name}" Animation`));
  return {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name: NAMES.locomotionGraph,
    entryStateId: "idle",
    states: [
      animState("idle", "Idle", "clip-idle", true, 80, 220),
      animState("walk", "Walk", "clip-walk", true, 400, 220),
      animState("run", "Run", "clip-run", true, 720, 220),
      animState("cheer", "Cheer", "clip-cheer", false, 80, 480),
    ],
    clips: [
      clip("clip-idle", MANNEQUIN_CLIPS.idle),
      clip("clip-walk", MANNEQUIN_CLIPS.walk),
      clip("clip-run", MANNEQUIN_CLIPS.run),
      clip("clip-cheer", MANNEQUIN_CLIPS.cheer),
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
    animationObject: createDefaultAnimationObjectGraph(),
    parameters: [CHEER.name],
  };
}

/**
 * The door Model imports as a rigid node animation (no Skeleton). With its
 * `open` and `close` clips the graph cycles Open → Close at half speed; any
 * other clip set falls back to one looping state.
 */
function doorGraphDocument(ctx: FeatureTestContext): AnimGraphDocument {
  const clips = ctx.assets.doorAnimations;
  const base: Pick<AnimGraphDocument, "schemaVersion" | "name" | "variables" | "animationObject" | "parameters"> = {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name: NAMES.doorGraph,
    variables: [],
    animationObject: createDefaultAnimationObjectGraph(),
    parameters: [],
  };
  if (clips.open && clips.close) {
    return {
      ...base,
      entryStateId: "open",
      states: [
        { ...animState("open", "Open", "clip-open", false, 80, 220), speed: 0.5 },
        { ...animState("close", "Close", "clip-close", false, 400, 220), speed: 0.5 },
      ],
      clips: [animationClip(ctx, "clip-open", clips.open), animationClip(ctx, "clip-close", clips.close)],
      // Non-looping states: Exit Time 1 passes once the clip has finished.
      transitions: [
        transition("open-to-close", "open", "close", 0.1, 0, FORWARD, [exitTime(1)]),
        transition("close-to-open", "close", "open", 0.1, 0, BACKWARD, [exitTime(1)]),
      ],
    };
  }
  const swing = requireRef(clips["open-and-close"] ?? Object.values(clips)[0], "a cabin-door-rotate Animation");
  return {
    ...base,
    entryStateId: "swing",
    states: [animState("swing", "Swing", "clip-swing", true, 80, 220)],
    clips: [animationClip(ctx, "clip-swing", swing)],
    transitions: [],
  };
}

function animState(id: string, name: string, clipId: string, loop: boolean, x: number, y: number): AnimState {
  return { id, name, clipId, speed: 1, loop, position: { x, y } };
}

/** Clip ref with the imported clip name and duration (Play re-resolves both from the catalog). */
function animationClip(ctx: FeatureTestContext, id: string, guid: string): AnimClipRef {
  const asset = ctx.registry.getByGuid(guid);
  if (!asset || asset.header.type !== "Animation") throw new Error(`FeatureTest Animation ${guid} is missing.`);
  const payload = normalizeAnimationPayload(asset.header.payload);
  return { id, kind: "animation", assetGuid: guid, clipName: payload.clipName, durationMs: payload.durationMs ?? 1000 };
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
    graph.nodes.push(gNode(andId, "boolean.and", 180, 40 + index * 100, { title: "Boolean And" }));
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
async function saveLocomotor(ctx: FeatureTestContext, graphGuid: string): Promise<PlacedClass> {
  const modelGuid = requireRef(ctx.assets.mannequin.modelGuid, "the Mannequin Model");
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
  const ref = await ctx.saveClass({ folder: FOLDER, name: NAMES.locomotor, parentClass: "Actor", graph });
  return { ref, components };
}

// ---------------------------------------------------------------------------
// Actors

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

/** Locomotor instance with a per-instance Phase (seconds) override. */
function locomotorActor(placed: PlacedClass, id: string, name: string, position: Vec3, phase: number): SerializedActor {
  return actor(id, name, tf(position), instanceComponents(id, placed.components), {
    classId: placed.ref.classId,
    properties: { Phase: phase },
  });
}

function caption(id: string, name: string, position: Vec3, text: string, fontAssetGuid: string | null): SerializedActor {
  return actor(id, name, tf(position), [
    comp(`${id}-text`, "Text3DComponent", {
      text,
      size: 0.5,
      color: [0.9, 0.9, 0.95],
      alignment: "center",
      fontAssetGuid,
    }),
  ]);
}

function roundTo(value: number, steps: number): number {
  return Math.round(value * steps) / steps;
}
