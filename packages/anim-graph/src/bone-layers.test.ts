import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { animBranchFilterKey, rotatorToQuat } from "@haptic/core";
import {
  ANIM_CONTROL_TRANSFORM_BONE_TYPE,
  ANIM_POSE_LAYERED_BLEND_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_POSE_SAVE_CACHED_TYPE,
  ANIM_POSE_SEQUENCE_PLAYER_TYPE,
  ANIM_POSE_USE_CACHED_TYPE,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  evaluateAnimGraph,
  primaryPosePlayer,
  validateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "./index";

type Node = SerializedGraph["nodes"][number];

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const player = (id: string, durationMs = 1000, data: Record<string, unknown> = {}): Node =>
  node(id, ANIM_POSE_SEQUENCE_PLAYER_TYPE, { assetGuid: id, clipName: id, durationMs, loop: true, ...data });
const output = (): Node => node(ANIM_POSE_OUTPUT_NODE_ID, "anim.pose.output", { __protected: true });
const wire = (source: string, target: string, targetHandle: string) => ({
  id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle,
});

function graphOf(nodes: Node[], edges: Array<ReturnType<typeof wire>>): SerializedGraph {
  return { nodes: [...nodes, output()], edges };
}

function oneState(stateGraph: SerializedGraph): AnimGraphDocument {
  return {
    ...createDefaultAnimGraph("Layers"),
    stateMachine: { entryStateId: "main", states: [{ id: "main", name: "Main", position: { x: 0, y: 0 }, stateGraph }], transitions: [] },
  };
}

const layerOf = (state: AnimEvalState, guid: string) => state.layers.filter((layer) => layer.clipAssetGuid === guid);

describe("Layered Blend Per Bone", () => {
  const upperBody = [{ branches: [{ bone: "spine_01", blendDepth: 2 }, { bone: "neck", blendDepth: -1 }] }];
  const layered = (data: Record<string, unknown> = {}) => graphOf(
    [player("walk"), player("attack", 500), node("layers", ANIM_POSE_LAYERED_BLEND_TYPE, { count: 1, layers: upperBody, ...data })],
    [wire("walk", "layers", "basePose"), wire("attack", "layers", "blendPose0"), wire("layers", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
  );

  it("tags the base and blend layers with the blend's inputs, the blend input at its Blend Weight", () => {
    const state = evaluateAnimGraph(oneState(layered({ "default:blendWeight0": 0.75 })), null, 0, {});
    expect(state.layerBlends).toEqual([{ filters: [animBranchFilterKey(upperBody[0]!.branches)], weights: [0.75] }]);
    expect(layerOf(state, "walk")).toEqual([expect.objectContaining({ weight: 1, masks: [{ blend: 0, input: -1 }] })]);
    expect(layerOf(state, "attack")).toEqual([expect.objectContaining({ weight: 0.75, masks: [{ blend: 0, input: 0 }] })]);
  });

  it("reads a wired Blend Weight, and at weight 0 plays the base alone while the blend input keeps its time", () => {
    const doc = oneState(layered());
    const wired = (weight: number): AnimGraphInputs => ({ poseData: () => ({ layers: { blendWeight0: weight } }) });
    const first = evaluateAnimGraph(doc, null, 0, wired(0.5));
    expect(first.layerBlends?.[0]?.weights).toEqual([0.5]);
    const off = evaluateAnimGraph(doc, first, 0.1, wired(0));
    expect(off.layerBlends).toBeUndefined();
    expect(off.layers).toEqual([expect.objectContaining({ clipAssetGuid: "walk", weight: 1 })]);
    expect(off.layers[0]!.masks).toBeUndefined();
    expect(off.players["main#attack"]?.normalised).toBeCloseTo(0.2, 6);
  });

  it("follows the Base Pose for the state's time", () => {
    expect(primaryPosePlayer(layered())?.id).toBe("walk");
  });

  it("nests: a layer inside two blends lists both, outermost first", () => {
    const graph = graphOf(
      [
        player("walk"), player("aim"), player("wave"),
        node("outer", ANIM_POSE_LAYERED_BLEND_TYPE, { layers: upperBody }),
        node("inner", ANIM_POSE_LAYERED_BLEND_TYPE, { layers: [{ branches: [{ bone: "hand_r", blendDepth: 0 }] }] }),
      ],
      [
        wire("walk", "outer", "basePose"), wire("inner", "outer", "blendPose0"),
        wire("aim", "inner", "basePose"), wire("wave", "inner", "blendPose0"),
        wire("outer", ANIM_POSE_OUTPUT_NODE_ID, "pose"),
      ],
    );
    const state = evaluateAnimGraph(oneState(graph), null, 0, {});
    expect(state.layerBlends).toHaveLength(2);
    expect(layerOf(state, "wave")[0]!.masks).toEqual([{ blend: 0, input: 0 }, { blend: 1, input: 0 }]);
    expect(layerOf(state, "aim")[0]!.masks).toEqual([{ blend: 0, input: 0 }, { blend: 1, input: -1 }]);
  });
});

describe("Cached poses", () => {
  /** Main saves Walk as "Loco" and layers it under itself twice: once as the base, once as a blend input. */
  const savesAndUses = () => graphOf(
    [
      player("walk", 1000, { events: [{ name: "Step", timeMs: 150, triggerWeight: 0.9 }] }),
      node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Loco" }),
      node("use-a", ANIM_POSE_USE_CACHED_TYPE, { name: "Loco" }),
      node("use-b", ANIM_POSE_USE_CACHED_TYPE, { name: " Loco " }),
      node("blend", "anim.pose.blend", { "default:alpha": 0.25 }),
    ],
    [
      wire("walk", "save", "pose"),
      wire("use-a", "blend", "a"), wire("use-b", "blend", "b"),
      wire("blend", ANIM_POSE_OUTPUT_NODE_ID, "pose"),
    ],
  );

  it("evaluates once a tick however often it is used: its player advances once", () => {
    const doc = oneState(savesAndUses());
    const first = evaluateAnimGraph(doc, null, 0, {});
    const next = evaluateAnimGraph(doc, first, 0.1, {});
    expect(next.players["main#walk"]?.normalised).toBeCloseTo(0.1, 6);
    expect(layerOf(next, "walk").map((layer) => layer.weight)).toEqual([0.75, 0.25]);
    expect(layerOf(next, "walk").every((layer) => layer.stateId === "main")).toBe(true);
  });

  it("fires its events once, at the uses' summed weight (each use alone is under the Trigger Weight)", () => {
    const doc = oneState(savesAndUses());
    let state = evaluateAnimGraph(doc, null, 0, {});
    state = evaluateAnimGraph(doc, state, 0.2, {});
    expect(state.events?.filter((event) => event.name === "Step")).toHaveLength(1);
  });

  it("keeps time across the states that use it", () => {
    const uses = (id: string) => ({
      id, name: id, position: { x: 0, y: 0 },
      stateGraph: graphOf([node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Loco" })], [wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")]),
    });
    const doc: AnimGraphDocument = {
      ...createDefaultAnimGraph("Shared"),
      stateMachine: {
        entryStateId: "a",
        states: [
          { id: "a", name: "A", position: { x: 0, y: 0 }, stateGraph: graphOf([player("walk"), node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Loco" }), node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Loco" })], [wire("walk", "save", "pose"), wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")]) },
          uses("b"),
        ],
        transitions: [{ id: "a-b", fromStateId: "a", toStateId: "b", blendSeconds: 0.2, priority: 0, ruleGraph: createDefaultTransitionRuleGraph() }],
      },
    };
    const go = (on: boolean): AnimGraphInputs => ({ decideTransition: () => ({ enter: on, exit: true }) });
    let state = evaluateAnimGraph(doc, null, 0, go(false));
    state = evaluateAnimGraph(doc, state, 0.3, go(false));
    state = evaluateAnimGraph(doc, state, 0.1, go(true));
    expect(state.stateId).toBe("b");
    // Both states play the one cached Walk, which went on from 0.3 to 0.4 rather than starting over in B.
    expect(state.players["a#walk"]?.normalised).toBeCloseTo(0.4, 6);
    expect(layerOf(state, "walk").every((layer) => layer.normalisedTime === state.players["a#walk"]!.normalised)).toBe(true);
    expect(layerOf(state, "walk").reduce((sum, layer) => sum + layer.weight, 0)).toBeCloseTo(1, 6);
  });

  it("adds nothing for an unknown name or a cached pose that uses itself", () => {
    const unknown = graphOf([node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Nope" })], [wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")]);
    expect(evaluateAnimGraph(oneState(unknown), null, 0, {}).layers).toEqual([]);
    const loop = graphOf(
      [node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Self" }), node("inner", ANIM_POSE_USE_CACHED_TYPE, { name: "Self" }), node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Self" })],
      [wire("inner", "save", "pose"), wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(evaluateAnimGraph(oneState(loop), null, 0, {}).layers).toEqual([]);
  });
});

describe("Transform Bone", () => {
  const transform = (data: Record<string, unknown>) => graphOf(
    [player("idle"), node("bone", ANIM_CONTROL_TRANSFORM_BONE_TYPE, { bone: "head", ...data })],
    [wire("idle", "bone", "sourcePose"), wire("bone", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
  );

  it("sends its changed channels: Rotation as a quaternion, each with its mode and space", () => {
    const state = evaluateAnimGraph(oneState(transform({
      rotationMode: "add",
      rotationSpace: "bone",
      translationMode: "replace",
      "default:translation": { x: 1, y: 2, z: 3 },
      "default:rotation": { pitch: 0, yaw: 30, roll: 0 },
      "default:alpha": 0.5,
    })), null, 0, {});
    const q = rotatorToQuat({ pitch: 0, yaw: 30, roll: 0 });
    expect(state.boneModifiers).toEqual([{
      bone: "head",
      alpha: 0.5,
      translation: { value: [1, 2, 3], mode: "replace", space: "actor" },
      rotation: { value: [q.x, q.y, q.z, q.w], mode: "add", space: "bone" },
    }]);
    expect(state.layers).toEqual([expect.objectContaining({ clipAssetGuid: "idle", weight: 1 })]);
  });

  it("changes nothing with every channel on Ignore, no bone, or Alpha 0", () => {
    expect(evaluateAnimGraph(oneState(transform({})), null, 0, {}).boneModifiers).toBeUndefined();
    expect(evaluateAnimGraph(oneState(transform({ bone: "", scaleMode: "add" })), null, 0, {}).boneModifiers).toBeUndefined();
    expect(evaluateAnimGraph(oneState(transform({ scaleMode: "add", "default:alpha": 0 })), null, 0, {}).boneModifiers).toBeUndefined();
  });

  it("reads wired values, defaults Scale to 1, and scales Alpha with its weight in the graph", () => {
    const graph = graphOf(
      [player("idle"), player("other"), node("bone", ANIM_CONTROL_TRANSFORM_BONE_TYPE, { bone: "head", scaleMode: "add", translationMode: "add" }), node("blend", "anim.pose.blend", { "default:alpha": 0.25 })],
      [wire("idle", "bone", "sourcePose"), wire("bone", "blend", "a"), wire("other", "blend", "b"), wire("blend", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    const state = evaluateAnimGraph(oneState(graph), null, 0, { poseData: () => ({ bone: { translation: { x: 0, y: 0.5, z: 0 } } }) });
    expect(state.boneModifiers).toEqual([expect.objectContaining({
      alpha: 0.75,
      translation: { value: [0, 0.5, 0], mode: "add", space: "actor" },
      scale: { value: [1, 1, 1], mode: "add", space: "actor" },
    })]);
  });

  it("applies a change deeper in the graph first, and carries the Layered Blend input it is under", () => {
    const graph = graphOf(
      [
        player("walk"), player("attack"),
        node("inner", ANIM_CONTROL_TRANSFORM_BONE_TYPE, { bone: "hand_r", rotationMode: "add" }),
        node("outer", ANIM_CONTROL_TRANSFORM_BONE_TYPE, { bone: "head", rotationMode: "add" }),
        node("layers", ANIM_POSE_LAYERED_BLEND_TYPE, { layers: [{ branches: [{ bone: "spine_01", blendDepth: 0 }] }] }),
      ],
      [
        wire("walk", "layers", "basePose"), wire("attack", "inner", "sourcePose"), wire("inner", "layers", "blendPose0"),
        wire("layers", "outer", "sourcePose"), wire("outer", ANIM_POSE_OUTPUT_NODE_ID, "pose"),
      ],
    );
    const state = evaluateAnimGraph(oneState(graph), null, 0, {});
    expect(state.boneModifiers?.map((modifier) => [modifier.bone, modifier.masks])).toEqual([
      ["hand_r", [{ blend: 0, input: 0 }]],
      ["head", undefined],
    ]);
  });
});

describe("cached pose and Transform Bone validation", () => {
  const codes = (doc: AnimGraphDocument) => validateAnimGraph(doc).map((diagnostic) => [diagnostic.code, diagnostic.nodeId]);

  it("needs each saved name once, and each used name saved", () => {
    const graph = graphOf(
      [
        player("walk"), player("run"),
        node("save", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Loco" }),
        node("again", ANIM_POSE_SAVE_CACHED_TYPE, { name: "Loco" }),
        node("blank", ANIM_POSE_SAVE_CACHED_TYPE, { name: " " }),
        node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "Missing" }),
      ],
      [wire("walk", "save", "pose"), wire("run", "again", "pose"), wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(codes(oneState(graph))).toEqual([
      ["anim.duplicateCachedPose", "again"],
      ["anim.emptyCachedPoseName", "blank"],
      ["anim.missingCachedPose", "use"],
    ]);
  });

  it("reports a cached pose that uses itself through another", () => {
    const graph = graphOf(
      [
        node("save-a", ANIM_POSE_SAVE_CACHED_TYPE, { name: "A" }),
        node("save-b", ANIM_POSE_SAVE_CACHED_TYPE, { name: "B" }),
        node("use-b", ANIM_POSE_USE_CACHED_TYPE, { name: "B" }),
        node("use-a", ANIM_POSE_USE_CACHED_TYPE, { name: "A" }),
        node("use", ANIM_POSE_USE_CACHED_TYPE, { name: "A" }),
      ],
      [wire("use-b", "save-a", "pose"), wire("use-a", "save-b", "pose"), wire("use", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
    );
    expect(codes(oneState(graph))).toEqual([
      ["anim.cachedPoseCycle", "save-a"],
      ["anim.cachedPoseCycle", "save-b"],
    ]);
  });

  it("warns on a Transform Bone with no bone", () => {
    const graph = graphOf([player("idle"), node("bone", ANIM_CONTROL_TRANSFORM_BONE_TYPE)], [wire("idle", "bone", "sourcePose"), wire("bone", ANIM_POSE_OUTPUT_NODE_ID, "pose")]);
    expect(validateAnimGraph(oneState(graph))).toEqual([expect.objectContaining({ code: "anim.missingBone", nodeId: "bone", severity: "warning" })]);
  });
});
