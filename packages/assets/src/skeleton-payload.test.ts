import { describe, expect, it } from "vitest";
import { normalizeSkeletonPayload } from "./skeleton-payload";

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

});
