import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_POSE_OUTPUT_NODE_ID,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  primaryPosePlayer,
  resolveAnimGraphClips,
  singlePlayerOf,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "./index";

type GraphNode = SerializedGraph["nodes"][number];

/** A one-state graph whose state graph is one Blend Space Player into the output. */
function blendSpaceDoc(data: Record<string, unknown>, skeletonGuid: string | null = "rig"): AnimGraphDocument {
  const playerNode: GraphNode = { id: "bs", type: "anim.pose.blendSpacePlayer", position: { x: 0, y: 0 }, data };
  const output: GraphNode = { id: ANIM_POSE_OUTPUT_NODE_ID, type: "anim.pose.output", position: { x: 300, y: 0 }, data: { __protected: true } };
  return {
    ...createDefaultAnimGraph("Loco", { dimension: "3d", skeletonGuid }),
    stateMachine: {
      entryStateId: "move",
      transitions: [],
      states: [{
        id: "move",
        name: "Move",
        position: { x: 0, y: 0 },
        stateGraph: {
          nodes: [playerNode, output],
          edges: [{ id: "bs->output", source: "bs", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "pose" }],
        },
      }],
    },
  };
}

/** Idle at 0, Walk at 2 and Run at 6 on a Speed axis; Run's clip is half as long. */
const speedSpace = {
  axes: [{ min: 0, max: 6, wrap: false, smoothingSeconds: 0 }],
  samples: [
    { animationGuid: "idle", clipName: "Idle", durationMs: 1000, x: 0, y: 0, rateScale: 1 },
    { animationGuid: "walk", clipName: "Walk", durationMs: 1000, x: 2, y: 0, rateScale: 1 },
    { animationGuid: "run", clipName: "Run", durationMs: 500, x: 6, y: 0, rateScale: 1 },
  ],
};

function inputs(x: number, extra: Record<string, unknown> = {}): AnimGraphInputs {
  return { poseData: (key) => (key === "move" ? { bs: { x, ...extra } } : undefined) };
}

const layerWeights = (state: AnimEvalState) =>
  Object.fromEntries(state.layers.map((layer) => [layer.clipAssetGuid, Number(layer.weight.toFixed(3))]));

describe("Blend Space Player", () => {
  it("plays the samples around X, weighted by distance, all at one time", () => {
    const doc = blendSpaceDoc({ assetGuid: "loco", blendSpace: speedSpace });
    const state = evaluateAnimGraph(doc, null, 0.25, inputs(1));
    expect(layerWeights(state)).toEqual({ idle: 0.5, walk: 0.5 });
    expect(state.layers.map((layer) => layer.clipName)).toEqual(["Idle", "Walk"]);
    // One cycle is 0.5 × 1000 + 0.5 × 1000 ms; a quarter second in, both sit a quarter of the way.
    expect(state.layers.map((layer) => Number(layer.normalisedTime.toFixed(3)))).toEqual([0.25, 0.25]);
  });

  it("lasts the weighted average of its samples' lengths over their rate scales", () => {
    const doc = blendSpaceDoc({ assetGuid: "loco", blendSpace: speedSpace });
    // Halfway from Walk to Run: 0.5 × 1000 + 0.5 × 500 = 750 ms a cycle.
    const state = evaluateAnimGraph(doc, null, 0.25, inputs(4));
    expect(layerWeights(state)).toEqual({ walk: 0.5, run: 0.5 });
    expect(state.layers[0]!.normalisedTime).toBeCloseTo(250 / 750, 6);
    expect(state.facts.durationSeconds).toBeCloseTo(0.75, 6);
    expect(state.normalisedTime).toBeCloseTo(250 / 750, 6);
    const scaled = blendSpaceDoc({
      assetGuid: "loco",
      blendSpace: { ...speedSpace, samples: speedSpace.samples.map((sample) => (sample.animationGuid === "run" ? { ...sample, rateScale: 0.5 } : sample)) },
    });
    // At rate scale 0.5 Run takes 1000 ms, so the cycle is 1000 ms.
    expect(evaluateAnimGraph(scaled, null, 0.25, inputs(6)).facts.durationSeconds).toBeCloseTo(1, 6);
  });

  it("keeps the samples' phase when the cycle's length changes, so feet stay in step", () => {
    const doc = blendSpaceDoc({ assetGuid: "loco", blendSpace: speedSpace });
    const walking = evaluateAnimGraph(doc, null, 0.5, inputs(2));
    expect(walking.layers[0]!.normalisedTime).toBeCloseTo(0.5, 6);
    // Now running: the 500 ms cycle goes on from halfway, not from 500 ms in.
    const running = evaluateAnimGraph(doc, walking, 0.1, inputs(6));
    expect(running.layers.map((layer) => layer.clipAssetGuid)).toEqual(["run"]);
    expect(running.layers[0]!.normalisedTime).toBeCloseTo(0.7, 6);
    expect(running.normalisedTime).toBeCloseTo(0.7, 6);
  });

  it("scales time by Play Rate and holds at 0", () => {
    const doc = blendSpaceDoc({ assetGuid: "loco", blendSpace: speedSpace });
    expect(evaluateAnimGraph(doc, null, 0.25, inputs(2, { playRate: 2 })).layers[0]!.normalisedTime).toBeCloseTo(0.5, 6);
    expect(evaluateAnimGraph(doc, null, 0.25, inputs(2, { playRate: 0 })).layers[0]!.normalisedTime).toBe(0);
  });

  it("eases an input over its Smoothing Time, the short way round a wrapping axis", () => {
    const smoothed = blendSpaceDoc({
      assetGuid: "loco",
      blendSpace: { ...speedSpace, axes: [{ min: 0, max: 6, wrap: false, smoothingSeconds: 1 }] },
    });
    // A fresh state starts on its input.
    const start = evaluateAnimGraph(smoothed, null, 0.1, inputs(0));
    expect(start.selectors["move#bs"]).toEqual([0]);
    // A third of the Smoothing Time covers 1 − e⁻¹ of the way to 6.
    const eased = evaluateAnimGraph(smoothed, start, 1 / 3, inputs(6));
    expect(eased.selectors["move#bs"]![0]).toBeCloseTo(6 * (1 - Math.exp(-1)), 6);

    const direction = blendSpaceDoc({
      assetGuid: "turn",
      blendSpace: {
        axes: [{ min: -180, max: 180, wrap: true, smoothingSeconds: 1 }],
        samples: [
          { animationGuid: "left", clipName: "Left", durationMs: 1000, x: -180, y: 0, rateScale: 1 },
          { animationGuid: "right", clipName: "Right", durationMs: 1000, x: 180, y: 0, rateScale: 1 },
        ],
      },
    });
    const facing = evaluateAnimGraph(direction, null, 0.1, inputs(170));
    const turned = evaluateAnimGraph(direction, facing, 1 / 3, inputs(-170));
    // 20° the short way past 180: 170 + 20 × (1 − e⁻¹) − 360.
    expect(turned.selectors["move#bs"]![0]).toBeCloseTo(170 + 20 * (1 - Math.exp(-1)) - 360, 6);
  });

  it("plays nothing before its Blend Space resolves", () => {
    const state = evaluateAnimGraph(blendSpaceDoc({ assetGuid: "loco" }), null, 0.25, inputs(1));
    expect(state.layers).toEqual([]);
    expect(state.facts.durationSeconds).toBe(1);
  });

  it("is the state's time source, but not a single player the state Inspector edits", () => {
    const graph = blendSpaceDoc({ assetGuid: "loco" }).stateMachine.states[0]!.stateGraph;
    expect(primaryPosePlayer(graph)?.id).toBe("bs");
    expect(singlePlayerOf(graph)).toBeNull();
  });
});

describe("Blend Space Player resolve and validation", () => {
  const catalog: AnimClipCatalogEntry[] = [
    {
      guid: "loco",
      type: "BlendSpace",
      name: "BS_Loco",
      skeletonGuid: "rig",
      blendSpace: {
        axes: [{ min: 0, max: 6, wrap: false, smoothingSeconds: 0.2 }],
        samples: [
          { animationGuid: "walk", x: 2, y: 0, rateScale: 1 },
          { animationGuid: "hero", x: 4, y: 0, rateScale: 1 },
          { animationGuid: "run", x: 6, y: 0, rateScale: 1.5 },
        ],
      },
    },
    { guid: "walk", type: "Animation", name: "Hero_Walk", clipName: "Walk", durationMs: 900, skeletonGuid: "rig" },
    { guid: "run", type: "Animation", name: "Hero_Run", clipName: "Run", skeletonGuid: "rig" },
    { guid: "hero", type: "Model", name: "Hero" },
    { guid: "other-rig", type: "BlendSpace", name: "BS_Large", skeletonGuid: "large", blendSpace: { axes: [{ min: 0, max: 1, wrap: false, smoothingSeconds: 0 }], samples: [] } },
  ];

  it("stores the Blend Space on the node with each sample's clip, dropping samples that are not Animations", () => {
    const resolved = resolveAnimGraphClips(blendSpaceDoc({ assetGuid: "loco" }), catalog);
    expect(resolved.stateMachine.states[0]!.stateGraph.nodes[0]!.data.blendSpace).toEqual({
      axes: [{ min: 0, max: 6, wrap: false, smoothingSeconds: 0.2 }],
      samples: [
        { animationGuid: "walk", clipName: "Walk", durationMs: 900, x: 2, y: 0, rateScale: 1 },
        // An Animation with no known length plays for a second.
        { animationGuid: "run", clipName: "Run", durationMs: 1000, x: 6, y: 0, rateScale: 1.5 },
      ],
    });
    // Resolving again changes nothing.
    expect(resolveAnimGraphClips(resolved, catalog)).toBe(resolved);
    // A guid that is no longer a Blend Space clears what was stored.
    const renamed = resolveAnimGraphClips(blendSpaceDoc({ assetGuid: "walk", blendSpace: speedSpace }), catalog);
    expect(renamed.stateMachine.states[0]!.stateGraph.nodes[0]!.data.blendSpace).toBeUndefined();
  });

  it("reports a Blend Space Player naming another asset type or a Blend Space on another Skeleton", () => {
    const codes = (assetGuid: string) =>
      validateAnimGraph(blendSpaceDoc({ assetGuid }), catalog, { dimension: "3d" }).map((diagnostic) => diagnostic.code);
    expect(codes("loco")).toEqual([]);
    expect(codes("walk")).toEqual(["anim.clipKind"]);
    expect(codes("other-rig")).toEqual(["anim.clipSkeleton"]);
  });
});
