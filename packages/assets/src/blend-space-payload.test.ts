import { describe, expect, it } from "vitest";
import { blendSpaceAssetGuids, createDefaultBlendSpacePayload, normalizeBlendSpacePayload } from "./blend-space-payload";

describe("normalizeBlendSpacePayload", () => {
  it("starts a new Blend Space on its Skeleton with one Speed axis and no samples", () => {
    expect(createDefaultBlendSpacePayload("rig")).toEqual({
      skeletonGuid: "rig",
      previewModelGuid: null,
      axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false }],
      samples: [],
    });
  });

  it("keeps a second axis and each sample's position and rate", () => {
    const payload = normalizeBlendSpacePayload({
      skeletonGuid: " rig ",
      axes: [
        { name: "Speed", min: 0, max: 4, gridDivisions: 4, smoothingSeconds: 0.2, wrap: false },
        { name: "Direction", min: -180, max: 180, gridDivisions: 8, smoothingSeconds: 0, wrap: true },
      ],
      samples: [{ animationGuid: "walk", x: 2, y: 90, rateScale: 1.5 }],
    });
    expect(payload.skeletonGuid).toBe("rig");
    expect(payload.axes).toHaveLength(2);
    expect(payload.axes[1]).toEqual({ name: "Direction", min: -180, max: 180, gridDivisions: 8, smoothingSeconds: 0, wrap: true });
    expect(payload.samples).toEqual([{ animationGuid: "walk", x: 2, y: 90, rateScale: 1.5 }]);
  });

  it("orders a reversed range, widens an empty one and bounds the grid and smoothing", () => {
    const payload = normalizeBlendSpacePayload({
      axes: [
        { name: "", min: 10, max: 2, gridDivisions: 500, smoothingSeconds: -1 },
        { min: 3, max: 3, gridDivisions: 0 },
      ],
    });
    expect(payload.axes[0]).toEqual({ name: "Speed", min: 2, max: 10, gridDivisions: 64, smoothingSeconds: 0, wrap: false });
    expect(payload.axes[1]).toMatchObject({ min: 3, max: 4, gridDivisions: 1 });
  });

  it("drops samples without an Animation, and reads a one-axis sample's y as 0", () => {
    const payload = normalizeBlendSpacePayload({
      axes: [{ name: "Speed", min: 0, max: 6 }],
      samples: [{ animationGuid: "", x: 1 }, { animationGuid: "run", x: 6, y: 5, rateScale: 0 }],
    });
    expect(payload.samples).toEqual([{ animationGuid: "run", x: 6, y: 0, rateScale: 1 }]);
  });

  it("lists the Skeleton and each sample's Animation as dependencies", () => {
    expect(blendSpaceAssetGuids({
      skeletonGuid: "rig",
      samples: [{ animationGuid: "walk", x: 0 }, { animationGuid: "run", x: 6 }, { animationGuid: "walk", x: 2 }],
    })).toEqual(["rig", "run", "walk"]);
  });
});
