import { describe, expect, it } from "vitest";
import {
  normalizeSkeletonPayload,
  quaternionToEulerDegrees,
  skeletonBoneNames,
  skeletonBoneTree,
} from "./skeleton-payload";

const REST = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

describe("normalizeSkeletonPayload", () => {
  it("keeps skin kind, model guid, and bones with their parents and rest", () => {
    expect(
      normalizeSkeletonPayload({
        modelGuid: " model-1 ",
        kind: "skin",
        bones: [
          { name: "Hips", parent: null, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          { name: "Spine", parent: "Hips", position: [0, 0.2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], posed: ["rotation", "bogus"] },
        ],
      }),
    ).toEqual({
      modelGuid: "model-1",
      kind: "skin",
      bones: [
        { name: "Hips", parent: null, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: "Spine", parent: "Hips", position: [0, 0.2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], posed: ["rotation"] },
      ],
    });
  });

  it("drops unnamed and repeated bones, fills a missing rest, and makes a bone with an unknown parent a root", () => {
    const payload = normalizeSkeletonPayload({
      kind: "hierarchy",
      bones: [{ name: "" }, { name: "root" }, { name: "root", parent: "x" }, { name: "arm", parent: "missing" }, 3],
    });
    expect(payload.bones).toEqual([
      { name: "root", parent: null, ...REST },
      { name: "arm", parent: null, ...REST },
    ]);
    expect(skeletonBoneNames(payload)).toEqual(["root", "arm"]);
  });

  it("defaults an unknown kind to hierarchy and a blank model guid to empty", () => {
    expect(normalizeSkeletonPayload({ bones: [] })).toEqual({ modelGuid: "", kind: "hierarchy", bones: [] });
  });
});

describe("skeletonBoneTree", () => {
  it("lists bones depth-first under each root with their depth", () => {
    const { bones } = normalizeSkeletonPayload({
      bones: [
        { name: "Spine", parent: "Hips" },
        { name: "Hips" },
        { name: "LeftLeg", parent: "Hips" },
        { name: "Head", parent: "Spine" },
      ],
    });
    expect(skeletonBoneTree(bones).map(({ bone, depth, hasChildren }) => [bone.name, depth, hasChildren])).toEqual([
      ["Hips", 0, true],
      ["Spine", 1, true],
      ["Head", 2, false],
      ["LeftLeg", 1, false],
    ]);
  });
});

describe("quaternionToEulerDegrees", () => {
  it("reads a quarter turn about Y as yaw", () => {
    const [x, y, z] = quaternionToEulerDegrees([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect([x, y, z].map((value) => Math.round(value))).toEqual([0, 90, 0]);
  });
});
