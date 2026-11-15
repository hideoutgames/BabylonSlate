import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_POSE_OUTPUT_NODE_ID,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  resolveAnimGraphClips,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "./index";

type GraphNode = SerializedGraph["nodes"][number];

/** A 2D graph whose one state plays a Sprite Blend Space Player, flipped on X when `flip` is set. */
function spriteDoc(data: Record<string, unknown>, flip = false): AnimGraphDocument {
  const player: GraphNode = { id: "bs", type: "anim.frame.spriteBlendSpacePlayer", position: { x: 0, y: 0 }, data };
  const output: GraphNode = { id: ANIM_POSE_OUTPUT_NODE_ID, type: "anim.frame.output", position: { x: 400, y: 0 }, data: { __protected: true } };
  const flipNode: GraphNode = { id: "flip", type: "anim.frame.flip", position: { x: 200, y: 0 }, data: { "default:flipX": true } };
  const nodes = flip ? [player, flipNode, output] : [player, output];
  const edges = flip
    ? [
        { id: "bs->flip", source: "bs", sourceHandle: "pose", target: "flip", targetHandle: "frame" },
        { id: "flip->out", source: "flip", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "frame" },
      ]
    : [{ id: "bs->out", source: "bs", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "frame" }];
  return {
    ...createDefaultAnimGraph("Robot", { dimension: "2d" }),
    stateMachine: { entryStateId: "move", transitions: [], states: [{ id: "move", name: "Move", position: { x: 0, y: 0 }, stateGraph: { nodes, edges } }] },
  };
}

/** Idle at Speed 0 (500 ms), Walk at 1 (800 ms) and Run at 2 (400 ms). */
function gait(extra: Record<string, unknown> = {}) {
  return {
    axes: [{ min: 0, max: 2, wrap: false, smoothingSeconds: 0 }],
    samples: [
      { animationGuid: "idle", clipName: "", durationMs: 500, x: 0, y: 0, rateScale: 1 },
      { animationGuid: "walk", clipName: "", durationMs: 800, x: 1, y: 0, rateScale: 1 },
      { animationGuid: "run", clipName: "", durationMs: 400, x: 2, y: 0, rateScale: 1 },
    ],
    hysteresis: 0.1,
    keepTime: true,
    ...extra,
  };
}

const speed = (x: number): AnimGraphInputs => ({ poseData: (key) => (key === "move" ? { bs: { x } } : undefined) });
const playing = (state: AnimEvalState) => state.layers.map((layer) => [layer.clipAssetGuid, layer.clipKind, layer.weight]);

describe("Sprite Blend Space Player", () => {
  it("plays the nearest Sprite Animation alone, over its own length", () => {
    const state = evaluateAnimGraph(spriteDoc({ assetGuid: "gait", blendSpace: gait() }), null, 0.2, speed(0.9));
    expect(playing(state)).toEqual([["walk", "sprite", 1]]);
    expect(state.layers[0]!.normalisedTime).toBeCloseTo(200 / 800, 6);
    expect(state.facts.durationSeconds).toBeCloseTo(0.8, 6);
  });

  it("keeps the playing sample inside its hysteresis, then changes", () => {
    const doc = spriteDoc({ assetGuid: "gait", blendSpace: gait() });
    const idle = evaluateAnimGraph(doc, null, 0.1, speed(0));
    // Distances are in fractions of the axis (0–2). At 0.55 Walk is nearer by (0.55 − 0.45) / 2 = 0.05: within the
    // 0.1 hysteresis, Idle keeps playing. At 0.8 it is nearer by 0.3, so Walk takes over.
    const held = evaluateAnimGraph(doc, idle, 0.1, speed(0.55));
    expect(playing(held)).toEqual([["idle", "sprite", 1]]);
    const changed = evaluateAnimGraph(doc, held, 0.1, speed(0.8));
    expect(playing(changed)).toEqual([["walk", "sprite", 1]]);
  });

  it("goes on from the cycle's position with Keep Time, and starts the next sample over without it", () => {
    const run = (keepTime: boolean) => {
      const doc = spriteDoc({ assetGuid: "gait", blendSpace: gait({ keepTime }) });
      const walking = evaluateAnimGraph(doc, null, 0.4, speed(1));
      expect(walking.layers[0]!.normalisedTime).toBeCloseTo(0.5, 6);
      return evaluateAnimGraph(doc, walking, 0.1, speed(2));
    };
    // Keep Time: halfway through Walk, Run goes on from halfway: 0.5 + 100 / 400.
    const kept = run(true);
    expect(playing(kept)).toEqual([["run", "sprite", 1]]);
    expect(kept.layers[0]!.normalisedTime).toBeCloseTo(0.75, 6);
    expect(kept.normalisedTime).toBeCloseTo(0.75, 6);
    // Without it Run starts at its first frame: 100 / 400.
    const restarted = run(false);
    expect(restarted.layers[0]!.normalisedTime).toBeCloseTo(0.25, 6);
    expect(restarted.normalisedTime).toBeCloseTo(0.25, 6);
  });

  it("is flipped by a Flip Frame after it", () => {
    const state = evaluateAnimGraph(spriteDoc({ assetGuid: "gait", blendSpace: gait() }, true), null, 0.1, speed(2));
    expect(state.layers).toEqual([expect.objectContaining({ clipAssetGuid: "run", flipX: true })]);
  });
});

describe("Sprite Blend Space Player resolve and validation", () => {
  const catalog: AnimClipCatalogEntry[] = [
    {
      guid: "gait",
      type: "SpriteBlendSpace",
      name: "Robot Gait",
      blendSpace: {
        axes: [{ min: 0, max: 2, wrap: false, smoothingSeconds: 0 }],
        samples: [
          { animationGuid: "walk-frames", x: 1, y: 0, rateScale: 1 },
          { animationGuid: "hero-walk", x: 2, y: 0, rateScale: 1 },
        ],
        hysteresis: 0.2,
        keepTime: false,
      },
    },
    { guid: "walk-frames", type: "SpriteAnimation", name: "Walk", durationMs: 640, frameCount: 8 },
    { guid: "hero-walk", type: "Animation", name: "Hero_Walk", clipName: "Walk", durationMs: 900 },
    { guid: "loco", type: "BlendSpace", name: "BS_Loco", blendSpace: { axes: [{ min: 0, max: 1, wrap: false, smoothingSeconds: 0 }], samples: [] } },
  ];

  it("stores the Sprite Blend Space with its Sprite Animations' lengths, its hysteresis and Keep Time, dropping 3D Animations", () => {
    const resolved = resolveAnimGraphClips(spriteDoc({ assetGuid: "gait" }), catalog);
    expect(resolved.stateMachine.states[0]!.stateGraph.nodes[0]!.data.blendSpace).toEqual({
      axes: [{ min: 0, max: 2, wrap: false, smoothingSeconds: 0 }],
      samples: [{ animationGuid: "walk-frames", clipName: "", durationMs: 640, x: 1, y: 0, rateScale: 1 }],
      hysteresis: 0.2,
      keepTime: false,
    });
  });

  it("reports a Sprite Blend Space Player naming a 3D Blend Space", () => {
    const codes = (assetGuid: string) =>
      validateAnimGraph(spriteDoc({ assetGuid }), catalog, { dimension: "2d" }).map((diagnostic) => diagnostic.code);
    expect(codes("gait")).toEqual([]);
    expect(codes("loco")).toEqual(["anim.clipKind"]);
  });
});
