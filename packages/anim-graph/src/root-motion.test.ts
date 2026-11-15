import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_POSE_APPLY_ADDITIVE_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_POSE_SEQUENCE_PLAYER_TYPE,
  animRootMotionDelta,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  resolveAnimGraphClips,
  type AnimClipCatalogEntry,
  type AnimClipRootMotion,
  type AnimEvalState,
  type AnimGraphDocument,
} from "./index";

type Node = SerializedGraph["nodes"][number];

/** A 1 s clip whose hips walk 2 along Z, evenly. */
const WALK: AnimClipRootMotion = { bone: "hips", track: { durationMs: 1000, stepMs: 500, x: [0, 0, 0], z: [0, 1, 2], yaw: [0, 0, 0] } };

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const player = (id: string, loop = true): Node =>
  node(id, ANIM_POSE_SEQUENCE_PLAYER_TYPE, { assetGuid: id, clipName: id, durationMs: 1000, loop });
const wire = (source: string, target: string, targetHandle: string) => ({
  id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle,
});

const CATALOG: AnimClipCatalogEntry[] = [
  { guid: "walk", type: "Animation", name: "walk", clipName: "walk", durationMs: 1000, rootMotion: WALK },
  { guid: "idle", type: "Animation", name: "idle", clipName: "idle", durationMs: 1000 },
];

function oneState(nodes: Node[], edges: Array<ReturnType<typeof wire>>): AnimGraphDocument {
  const stateGraph: SerializedGraph = { nodes: [...nodes, node(ANIM_POSE_OUTPUT_NODE_ID, "anim.pose.output", { __protected: true })], edges };
  return resolveAnimGraphClips({
    ...createDefaultAnimGraph("Root"),
    stateMachine: { entryStateId: "main", states: [{ id: "main", name: "Main", position: { x: 0, y: 0 }, stateGraph }], transitions: [] },
  }, CATALOG);
}

function run(doc: AnimGraphDocument, ticks: number, dt = 0.1): AnimEvalState[] {
  const states: AnimEvalState[] = [];
  let state: AnimEvalState | null = null;
  for (let i = 0; i < ticks; i++) {
    state = evaluateAnimGraph(doc, state, dt, {});
    states.push(state);
  }
  return states;
}

describe("root motion", () => {
  it("moves by each tick's travel of a playing clip, and tags its layer with the bone render holds", () => {
    const states = run(oneState([player("walk")], [wire("walk", ANIM_POSE_OUTPUT_NODE_ID, "pose")]), 5);
    expect(states[0]!.layers[0]!.rootMotionBone).toBe("hips");
    // The first tick starts the clip; each later one carries 0.1 s of a 2-per-second walk.
    for (const state of states.slice(1)) expect(state.rootMotion?.z).toBeCloseTo(0.2, 9);
  });

  it("carries on through a loop's wrap", () => {
    const states = run(oneState([player("walk")], [wire("walk", ANIM_POSE_OUTPUT_NODE_ID, "pose")]), 14, 0.15);
    const total = states.slice(1).reduce((sum, state) => sum + (state.rootMotion?.z ?? 0), 0);
    expect(total).toBeCloseTo(13 * 0.15 * 2, 6);
  });

  it("scales by the clip's weight in a blend, and moves nothing for a clip without root motion", () => {
    const blend = oneState(
      [player("walk"), player("idle"), node("blend", "anim.pose.blend", { "default:alpha": 0.75 })],
      [wire("walk", "blend", "a"), wire("idle", "blend", "b"), wire("blend", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(run(blend, 2)[1]!.rootMotion?.z).toBeCloseTo(0.05, 9);
    expect(run(oneState([player("idle")], [wire("idle", ANIM_POSE_OUTPUT_NODE_ID, "pose")]), 3)[2]!.rootMotion).toBeUndefined();
  });

  it("takes none from an additive input", () => {
    const additive = oneState(
      [player("idle"), player("walk"), node("apply", ANIM_POSE_APPLY_ADDITIVE_TYPE)],
      [wire("idle", "apply", "base"), wire("walk", "apply", "additive"), wire("apply", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(run(additive, 3)[2]!.rootMotion).toBeUndefined();
  });

  it("turns a pass's travel by the turn the clip made before it", () => {
    const turning: AnimClipRootMotion = { bone: "hips", track: { durationMs: 1000, stepMs: 1000, x: [0, 0], z: [0, 1], yaw: [0, 90] } };
    // From halfway (turned 45°) to the end: half a unit of travel along the clip's Z, seen from 45° round.
    const delta = animRootMotionDelta(turning, { from: 0.5, to: 1, inclusive: false, loop: false });
    expect(delta.yaw).toBeCloseTo(45, 9);
    expect(delta.z).toBeCloseTo(0.5 * Math.SQRT1_2, 9);
    expect(delta.x).toBeCloseTo(-0.5 * Math.SQRT1_2, 9);
  });
});
