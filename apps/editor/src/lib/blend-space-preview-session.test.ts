import { describe, expect, it } from "vitest";
import { BlendSpacePreviewSession } from "./blend-space-preview-session";

const speedSpace = {
  axes: [{ min: 0, max: 6, wrap: false, smoothingSeconds: 0 }],
  samples: [
    { animationGuid: "walk", clipName: "Walk", durationMs: 1000, x: 2, y: 0, rateScale: 1 },
    { animationGuid: "run", clipName: "Run", durationMs: 500, x: 6, y: 0, rateScale: 1 },
  ],
};

const weights = (session: BlendSpacePreviewSession) =>
  Object.fromEntries((session.getState()?.layers ?? []).map((layer) => [layer.clipAssetGuid, Number(layer.weight.toFixed(3))]));

describe("BlendSpacePreviewSession", () => {
  it("plays the Blend Space at the preview point through the evaluator, in real time × Speed", () => {
    const session = new BlendSpacePreviewSession();
    session.setBlendSpace(speedSpace);
    session.setPoint({ x: 4, y: 0 });
    expect(weights(session)).toEqual({ walk: 0.5, run: 0.5 });
    // Halfway: a 750 ms cycle. 80 ms at Speed 0.5 is 40 ms of it.
    session.setSpeed(0.5);
    session.advanceRealTime(0.08);
    expect(session.getState()!.normalisedTime).toBeCloseTo(40 / 750, 6);
  });

  it("holds while paused but still follows the preview point", () => {
    const session = new BlendSpacePreviewSession();
    session.setBlendSpace(speedSpace);
    session.setPlaying(false);
    session.advanceRealTime(0.05);
    expect(session.getState()!.normalisedTime).toBe(0);
    session.setPoint({ x: 6, y: 0 });
    expect(weights(session)).toEqual({ run: 1 });
  });

  it("advances at most a tenth of a second for one long frame", () => {
    const session = new BlendSpacePreviewSession();
    session.setBlendSpace(speedSpace);
    session.setPoint({ x: 2, y: 0 });
    session.advanceRealTime(5);
    expect(session.getState()!.normalisedTime).toBeCloseTo(0.1, 6);
  });
});

describe("BlendSpacePreviewSession for a Sprite Blend Space", () => {
  it("plays the nearest Sprite Animation alone at the preview point", () => {
    const session = new BlendSpacePreviewSession("2d");
    session.setBlendSpace({
      axes: [{ min: 0, max: 2, wrap: false, smoothingSeconds: 0 }],
      samples: [
        { animationGuid: "idle", clipName: "", durationMs: 500, x: 0, y: 0, rateScale: 1 },
        { animationGuid: "walk", clipName: "", durationMs: 800, x: 1, y: 0, rateScale: 1 },
      ],
      hysteresis: 0,
      keepTime: true,
    });
    session.setPoint({ x: 0.9, y: 0 });
    expect(session.getState()?.layers).toEqual([expect.objectContaining({ clipAssetGuid: "walk", clipKind: "sprite", weight: 1 })]);
  });
});
