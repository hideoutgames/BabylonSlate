import { describe, expect, it } from "vitest";
import { animGraphPlaysAsset, animPoseNodePropertyRows, type AnimClipPickGraph } from "./anim-pose-inspector";

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

describe("Phase 5b pose node rows", () => {
  const rowsOf = (typeId: string, data: Record<string, unknown>, extra: { bones?: string[]; cachedPoses?: string[] } = {}) => {
    const patches: Array<Record<string, unknown>> = [];
    const rows = animPoseNodePropertyRows(typeId, data, (patch) => patches.push(patch), {
      assetEntries: [],
      onPickClip: () => undefined,
      ...extra,
    });
    return { rows, patches };
  };

  it("sets a Layered Blend Per Bone's blend inputs from 1 to 16", () => {
    const { rows, patches } = rowsOf("anim.pose.layeredBlendPerBone", {});
    const count = rows.find((row) => row.id === "count");
    expect(count).toMatchObject({ label: "Blend Poses", value: 1, min: 1, max: 16 });
    if (count?.kind === "number") count.onChange(40);
    expect(patches).toEqual([{ count: 16 }]);
  });

  it("names a Slot's slot, DefaultSlot when blank", () => {
    const { rows, patches } = rowsOf("anim.frame.slot", {});
    expect(rows).toEqual([expect.objectContaining({ kind: "text", label: "Slot Name", value: "DefaultSlot" })]);
    if (rows[0]?.kind === "text") rows[0].onChange("  ");
    expect(patches).toEqual([{ slotName: "DefaultSlot" }]);
  });

  it("names a Save Cached Pose, and picks a Use Cached Pose's from the saved names, keeping a missing one", () => {
    const save = rowsOf("anim.pose.saveCachedPose", { name: "Loco" });
    expect(save.rows).toEqual([expect.objectContaining({ kind: "text", label: "Name", value: "Loco" })]);
    const use = rowsOf("anim.pose.useCachedPose", { name: "Gone" }, { cachedPoses: ["Aim", "Loco"] });
    expect(use.rows[0]).toMatchObject({ kind: "enum", label: "Cached Pose", value: "Gone", verbatim: true });
    expect(use.rows[0]?.kind === "enum" ? use.rows[0].options.map((option) => option.value) : []).toEqual(["Gone", "Aim", "Loco"]);
  });

  it("picks a Transform Bone's bone from the Skeleton and shows a channel's space only while it changes the bone", () => {
    const { rows, patches } = rowsOf("anim.control.transformBone", { bone: "head", rotationMode: "add" }, { bones: ["root", "head"] });
    expect(rows.map((row) => row.label)).toEqual(["Bone", "Translation Mode", "Rotation Mode", "Rotation Space", "Scale Mode"]);
    expect(rows[0]).toMatchObject({ kind: "enum", verbatim: true, value: "head" });
    const space = rows.find((row) => row.id === "rotationSpace");
    expect(space).toMatchObject({ value: "actor" });
    if (space?.kind === "enum") space.onChange("bone");
    expect(patches).toEqual([{ rotationSpace: "bone" }]);
    // Without a Skeleton the bone is typed.
    expect(rowsOf("anim.control.transformBone", {}).rows[0]).toMatchObject({ kind: "text", label: "Bone" });
  });
});
