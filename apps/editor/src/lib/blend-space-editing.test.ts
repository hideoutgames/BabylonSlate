import { describe, expect, it } from "vitest";
import { createDefaultBlendSpacePayload, type BlendSpacePayload } from "@haptic/assets";
import {
  addBlendSpaceSample,
  blendSpaceNodeDataOf,
  blendSpacePreviewPoint,
  moveBlendSpaceSample,
  patchBlendSpaceAxis,
  removeBlendSpaceSample,
  setBlendSpaceAxisCount,
  snapToBlendSpaceGrid,
  spriteBlendSpaceNodeDataOf,
} from "./blend-space-editing";

const speedAxis = { name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false };
const directionAxis = { name: "Direction", min: -180, max: 180, gridDivisions: 8, smoothingSeconds: 0, wrap: true };

function twoAxes(): BlendSpacePayload {
  return { skeletonGuid: "rig", previewModelGuid: null, axes: [speedAxis, directionAxis], samples: [] };
}

describe("snapToBlendSpaceGrid", () => {
  it.each([
    [2.4, 2],
    [2.6, 3],
    [-1, 0],
    [9, 6],
  ])("snaps %d to %d on a 0–6 axis of 6 divisions", (value, expected) => {
    expect(snapToBlendSpaceGrid(speedAxis, value)).toBe(expected);
  });

  it("snaps to steps that are not whole numbers without float noise", () => {
    expect(snapToBlendSpaceGrid({ ...speedAxis, max: 1, gridDivisions: 10 }, 0.31)).toBe(0.3);
    expect(snapToBlendSpaceGrid(directionAxis, 50)).toBe(45);
  });
});

describe("Blend Space samples", () => {
  it("adds an Animation snapped to the grid, with Rate Scale 1", () => {
    const payload = addBlendSpaceSample(twoAxes(), "walk", { x: 2.3, y: 100 });
    expect(payload.samples).toEqual([{ animationGuid: "walk", x: 2, y: 90, rateScale: 1 }]);
  });

  it("keeps y at 0 on one axis", () => {
    expect(addBlendSpaceSample(createDefaultBlendSpacePayload("rig"), "walk", { x: 4.2, y: 50 }).samples[0]).toMatchObject({ x: 4, y: 0 });
  });

  it("moves a sample snapped to the grid, and returns the same payload when the snap does not change it", () => {
    const placed = addBlendSpaceSample(twoAxes(), "walk", { x: 2, y: 0 });
    const moved = moveBlendSpaceSample(placed, 0, { x: 4.9, y: -50 });
    expect(moved.samples[0]).toMatchObject({ x: 5, y: -45 });
    expect(moveBlendSpaceSample(moved, 0, { x: 5.1, y: -40 })).toBe(moved);
    expect(moveBlendSpaceSample(moved, 3, { x: 1, y: 1 })).toBe(moved);
  });

  it("removes a sample by index", () => {
    const payload = addBlendSpaceSample(addBlendSpaceSample(twoAxes(), "walk", { x: 2, y: 0 }), "run", { x: 6, y: 0 });
    expect(removeBlendSpaceSample(payload, 0).samples.map((sample) => sample.animationGuid)).toEqual(["run"]);
  });
});

describe("Blend Space axes", () => {
  it("adds a Direction axis with samples at its minimum, and drops it back to one axis keeping X", () => {
    const one = addBlendSpaceSample(createDefaultBlendSpacePayload("rig"), "walk", { x: 2, y: 0 });
    const two = setBlendSpaceAxisCount(one, 2);
    expect(two.axes[1]).toMatchObject({ name: "Direction", min: -180, max: 180, wrap: true });
    expect(two.samples[0]).toMatchObject({ x: 2, y: -180 });
    const back = setBlendSpaceAxisCount(two, 1);
    expect(back.axes).toHaveLength(1);
    expect(back.samples[0]).toMatchObject({ x: 2, y: 0 });
    expect(setBlendSpaceAxisCount(back, 1)).toBe(back);
  });

  it("changes an axis but refuses an empty or reversed range", () => {
    const payload = twoAxes();
    expect(patchBlendSpaceAxis(payload, 1, { name: "Turn", smoothingSeconds: 0.25 }).axes[1]).toMatchObject({ name: "Turn", smoothingSeconds: 0.25 });
    expect(patchBlendSpaceAxis(payload, 0, { max: 0 })).toBe(payload);
    expect(patchBlendSpaceAxis(payload, 0, { min: 7 })).toBe(payload);
    expect(patchBlendSpaceAxis(payload, 0, { gridDivisions: 2.6 }).axes[0].gridDivisions).toBe(3);
  });
});

describe("blendSpacePreviewPoint", () => {
  it("starts at the axes' minimums until the point is placed", () => {
    expect(blendSpacePreviewPoint(twoAxes(), null)).toEqual({ x: 0, y: -180 });
    expect(blendSpacePreviewPoint(createDefaultBlendSpacePayload(null), null)).toEqual({ x: 0, y: 0 });
    expect(blendSpacePreviewPoint(twoAxes(), { x: 3, y: 10 })).toEqual({ x: 3, y: 10 });
  });
});

describe("blendSpaceNodeDataOf", () => {
  it("fills each sample's clip and Duration from its Animation, leaving out samples whose Animation is missing", () => {
    const payload = {
      ...twoAxes(),
      samples: [
        { animationGuid: "walk", x: 2, y: 0, rateScale: 1 },
        { animationGuid: "gone", x: 4, y: 0, rateScale: 1 },
        { animationGuid: "run", x: 6, y: 90, rateScale: 0.5 },
      ],
    };
    const animations: Record<string, { payload: unknown }> = {
      walk: { payload: { clipName: "Walk", durationMs: 1200 } },
      run: { payload: { clipName: "Run" } },
    };
    expect(blendSpaceNodeDataOf(payload, (guid) => animations[guid])).toEqual({
      axes: [
        { min: 0, max: 6, wrap: false, smoothingSeconds: 0 },
        { min: -180, max: 180, wrap: true, smoothingSeconds: 0 },
      ],
      samples: [
        { animationGuid: "walk", clipName: "Walk", durationMs: 1200, x: 2, y: 0, rateScale: 1 },
        { animationGuid: "run", clipName: "Run", durationMs: 1000, x: 6, y: 90, rateScale: 0.5 },
      ],
    });
  });

describe("spriteBlendSpaceNodeDataOf", () => {
  it("fills each sample's Sprite Animation length and carries the hysteresis and Keep Time", () => {
    const frames = (frameDurationMs: number) => ({ payload: { frameDurationMs, frames: [{ textureGuid: "t" }] } });
    const data = spriteBlendSpaceNodeDataOf(
      {
        axes: [{ name: "Speed", min: 0, max: 1, gridDivisions: 2, smoothingSeconds: 0, wrap: false }],
        samples: [
          { animationGuid: "idle", x: 0, y: 0, rateScale: 1 },
          { animationGuid: "gone", x: 1, y: 0, rateScale: 1 },
        ],
        hysteresis: 0.1,
        keepTime: false,
      },
      (guid) => (guid === "idle" ? frames(250) : undefined),
    );
    expect(data.samples).toEqual([{ animationGuid: "idle", clipName: "", durationMs: 250, x: 0, y: 0, rateScale: 1 }]);
    expect(data).toMatchObject({ hysteresis: 0.1, keepTime: false });
  });
});
});
