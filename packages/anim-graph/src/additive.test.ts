import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_CONTROL_TRANSFORM_BONE_TYPE,
  ANIM_POSE_APPLY_ADDITIVE_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_POSE_SAVE_CACHED_TYPE,
  ANIM_POSE_SEQUENCE_PLAYER_TYPE,
  ANIM_POSE_USE_CACHED_TYPE,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  primaryPosePlayer,
  resolveAnimGraphClips,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimGraphDocument,
} from "./index";

type Node = SerializedGraph["nodes"][number];

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const player = (id: string, guid = id): Node =>
  node(id, ANIM_POSE_SEQUENCE_PLAYER_TYPE, { assetGuid: guid, clipName: guid, durationMs: 1000, loop: true });
const wire = (source: string, target: string, targetHandle: string) => ({
  id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle,
});

function oneState(nodes: Node[], edges: Array<ReturnType<typeof wire>>): AnimGraphDocument {
  const stateGraph: SerializedGraph = { nodes: [...nodes, node(ANIM_POSE_OUTPUT_NODE_ID, "anim.pose.output", { __protected: true })], edges };
  return {
    ...createDefaultAnimGraph("Additive"),
    skeletonGuid: "rig",
    stateMachine: { entryStateId: "main", states: [{ id: "main", name: "Main", position: { x: 0, y: 0 }, stateGraph }], transitions: [] },
  };
}

const animation = (guid: string, extra: Partial<AnimClipCatalogEntry> = {}): AnimClipCatalogEntry => ({
  guid, type: "Animation", name: guid, clipName: `${guid}-clip`, durationMs: 2000, skeletonGuid: "rig", ...extra,
});

const CATALOG: AnimClipCatalogEntry[] = [
  animation("idle"),
  animation("lean", { additive: { base: "restPose" } }),
  animation("flinch", { additive: { base: "firstFrame" } }),
  animation("aim", { additive: { base: "animation", animationGuid: "idle", timeMs: 500 } }),
  animation("orphan", { additive: { base: "animation", animationGuid: "gone" } }),
];

/** Idle as the Base Pose, `additive` at Alpha 0.4 on the Additive input. */
const applied = (additive: string) => oneState(
  [player("idle"), player(additive), node("apply", ANIM_POSE_APPLY_ADDITIVE_TYPE, { "default:alpha": 0.4 })],
  [wire("idle", "apply", "base"), wire(additive, "apply", "additive"), wire("apply", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
);

describe("Apply Additive", () => {
  it("plays the base and marks the additive input's layers additive at Alpha, the state's time following the base", () => {
    const doc = resolveAnimGraphClips(applied("lean"), CATALOG);
    const state = evaluateAnimGraph(doc, null, 0, {});
    expect(state.layers.map((layer) => [layer.clipAssetGuid, layer.weight, layer.additive ?? false])).toEqual([
      ["idle", 1, false],
      ["lean", 0.4, true],
    ]);
    // A rest-pose additive needs no base clip.
    expect(state.layers[1]!.additiveBase).toBeUndefined();
    expect(primaryPosePlayer(doc.stateMachine.states[0]!.stateGraph)?.id).toBe("idle");
  });

  it("names the base clip of an Animation additive to its first frame or to another Animation's frame", () => {
    const flinch = evaluateAnimGraph(resolveAnimGraphClips(applied("flinch"), CATALOG), null, 0, {});
    expect(flinch.layers[1]!.additiveBase).toEqual({ clipAssetGuid: "flinch", clipName: "flinch-clip", normalisedTime: 0 });
    const aim = evaluateAnimGraph(resolveAnimGraphClips(applied("aim"), CATALOG), null, 0, {});
    // 500 ms into Idle's 2000 ms Duration.
    expect(aim.layers[1]!.additiveBase).toEqual({ clipAssetGuid: "idle", clipName: "idle-clip", normalisedTime: 0.25 });
    // A base Animation the catalog lacks falls back to the rest pose.
    const orphan = resolveAnimGraphClips(applied("orphan"), CATALOG).stateMachine.states[0]!.stateGraph.nodes.find((entry) => entry.id === "orphan");
    expect(orphan?.data.additive).toEqual({ base: "restPose" });
  });

  it("carries the additive input into a cached pose, and drops bone changes there", () => {
    const doc = resolveAnimGraphClips(oneState(
      [
        player("idle"), player("lean"),
        node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Lean" }),
        node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Lean" }),
        node("bone", ANIM_CONTROL_TRANSFORM_BONE_TYPE, { bone: "head", rotationMode: "add" }),
        node("apply", ANIM_POSE_APPLY_ADDITIVE_TYPE),
      ],
      [
        wire("lean", "bone", "sourcePose"), wire("bone", "save", "pose"),
        wire("idle", "apply", "base"), wire("use", "apply", "additive"), wire("apply", ANIM_POSE_OUTPUT_NODE_ID, "pose"),
      ],
    ), CATALOG);
    const state = evaluateAnimGraph(doc, null, 0, {});
    expect(state.layers.find((layer) => layer.clipAssetGuid === "lean")).toMatchObject({ additive: true, weight: 1 });
    expect(state.boneModifiers).toBeUndefined();
  });
});

describe("additive validation", () => {
  const codes = (doc: AnimGraphDocument) => validateAnimGraph(doc, CATALOG, { dimension: "3d" }).map((row) => [row.code, row.nodeId]);

  it("accepts an additive Animation under the Additive input", () => {
    expect(codes(applied("lean"))).toEqual([]);
  });

  it("reports an additive Animation played as a pose, and a plain one under the Additive input", () => {
    expect(codes(oneState([player("lean")], [wire("lean", ANIM_POSE_OUTPUT_NODE_ID, "pose")]))).toEqual([["anim.additiveAsPose", "lean"]]);
    expect(codes(applied("idle"))).toEqual([["anim.notAdditive", "idle"]]);
  });

  it("follows cached poses into the context they are used in", () => {
    const doc = oneState(
      [
        player("idle"), player("lean"),
        node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Lean" }),
        node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Lean" }),
      ],
      [wire("lean", "save", "pose"), wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(codes(doc)).toEqual([["anim.additiveAsPose", "lean"]]);
  });
});
