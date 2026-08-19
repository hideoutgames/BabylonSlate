import { describe, expect, it } from "vitest";
import {
  normalizeSkeletonPayload,
  remapSkeletonPayloadGuids,
  skeletonAssetGuids,
} from "./skeleton-payload";

describe("normalizeSkeletonPayload", () => {
  it("keeps skin kind, model guid, and named bones", () => {
    expect(
      normalizeSkeletonPayload({
        modelGuid: " model-1 ",
        kind: "skin",
        boneNames: ["Hips", "Spine", "", 2],
      }),
    ).toEqual({
      modelGuid: "model-1",
      kind: "skin",
      boneNames: ["Hips", "Spine"],
    });
  });

  it("keeps hierarchy kind", () => {
    expect(
      normalizeSkeletonPayload({
        modelGuid: "mannequin",
        kind: "hierarchy",
        boneNames: ["root", "torso"],
      }).kind,
    ).toBe("hierarchy");
  });

  it("defaults unknown kind to hierarchy when bones exist and skin is not set", () => {
    expect(
      normalizeSkeletonPayload({
        modelGuid: "m",
        boneNames: ["root"],
      }).kind,
    ).toBe("hierarchy");
  });

  it("rejects a blank model guid", () => {
    expect(normalizeSkeletonPayload({ kind: "skin", boneNames: ["Hips"] }).modelGuid).toBe(
      "",
    );
  });

  it("rewrites modelGuid through remapSkeletonPayloadGuids", () => {
    const remapped = remapSkeletonPayloadGuids(
      "Skeleton",
      { modelGuid: "old", kind: "skin", boneNames: ["Hips"] },
      new Map([["old", "next"]]),
    );
    expect(remapped.modelGuid).toBe("next");
    expect(skeletonAssetGuids(remapped)).toEqual(["next"]);
  });

  it("leaves non-Skeleton payloads alone", () => {
    const payload = { clipName: "Walk" };
    expect(remapSkeletonPayloadGuids("Animation", payload, new Map())).toBe(payload);
  });
});
