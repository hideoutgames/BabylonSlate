import { describe, expect, it } from "vitest";
import {
  nextSkeletonSocketName,
  normalizeSkeletonPayload,
  quaternionToEulerDegrees,
  skeletonAttachPointNames,
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
      sockets: [],
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
    expect(normalizeSkeletonPayload({ bones: [] })).toEqual({ modelGuid: "", kind: "hierarchy", bones: [], sockets: [] });
  });

  it("keeps named sockets with their bone and offset, dropping unnamed ones and names a bone or socket already has", () => {
    const payload = normalizeSkeletonPayload({
      bones: [{ name: "hand" }],
      sockets: [
        { name: " Grip ", bone: "hand", position: [0.1, 0, 0], rotation: [0, 0.7071, 0, 0.7071], scale: [2, 2, 2] },
        { name: "hand", bone: "hand" },
        { name: "Grip", bone: "hand" },
        { name: "", bone: "hand" },
        { name: "Muzzle", bone: "gone", position: "x" },
      ],
    });
    expect(payload.sockets).toEqual([
      { name: "Grip", bone: "hand", position: [0.1, 0, 0], rotation: [0, 0.7071, 0, 0.7071], scale: [2, 2, 2] },
      { name: "Muzzle", bone: "gone", ...REST },
    ]);
    expect(skeletonAttachPointNames(payload)).toEqual(["hand", "Grip", "Muzzle"]);
  });

  it("names a new socket after its bone, unique among bones and sockets", () => {
    const payload = normalizeSkeletonPayload({
      bones: [{ name: "hand" }, { name: "hand_Socket2" }],
      sockets: [{ name: "hand_Socket", bone: "hand" }],
    });
    expect(nextSkeletonSocketName(payload, "hand")).toBe("hand_Socket3");
    expect(nextSkeletonSocketName(payload, "head")).toBe("head_Socket");
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
