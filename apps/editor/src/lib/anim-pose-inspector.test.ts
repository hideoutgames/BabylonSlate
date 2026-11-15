import { describe, expect, it } from "vitest";
import { animGraphPlaysAsset, type AnimClipPickGraph } from "./anim-pose-inspector";

const onRig: AnimClipPickGraph = { dimension: "3d", skeletonGuid: "rig" };
const noSkeleton: AnimClipPickGraph = { dimension: "3d", skeletonGuid: null };
const twoD: AnimClipPickGraph = { dimension: "2d", skeletonGuid: null };

describe("animGraphPlaysAsset", () => {
  it.each([
    ["an Animation on the graph's Skeleton", { type: "Animation", payload: { skeletonGuid: "rig" } }, onRig, true],
    ["an Animation on another Skeleton", { type: "Animation", payload: { skeletonGuid: "ogre" } }, onRig, false],
    ["an Animation with no Skeleton in a graph with one", { type: "Animation", payload: {} }, onRig, false],
    ["an Animation with no Skeleton in a graph with none", { type: "Animation", payload: {} }, noSkeleton, true],
    ["a Blend Space on the graph's Skeleton", { type: "BlendSpace", payload: { skeletonGuid: "rig" } }, onRig, true],
    ["a Blend Space on another Skeleton", { type: "BlendSpace", payload: { skeletonGuid: "ogre" } }, onRig, false],
    ["a Sprite Animation in a 3D graph", { type: "SpriteAnimation", payload: {} }, onRig, false],
    ["a Sprite Animation in a 2D graph", { type: "SpriteAnimation", payload: {} }, twoD, true],
    ["a Sprite Blend Space in a 2D graph", { type: "SpriteBlendSpace", payload: {} }, twoD, true],
    ["an Animation in a 2D graph", { type: "Animation", payload: { skeletonGuid: null } }, twoD, false],
    ["a Texture", { type: "Texture", payload: {} }, onRig, false],
  ])("%s plays: %s", (_label, asset, graph, expected) => {
    expect(animGraphPlaysAsset(asset, graph)).toBe(expected);
  });
});
