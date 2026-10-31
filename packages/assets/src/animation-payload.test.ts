import { describe, expect, it } from "vitest";
import {
  modelClipAnimationGuidsFromAnimations,
  normalizeAnimationPayload,
  retargetAnimationLoadsFromAnimations,
} from "./animation-payload";

describe("normalizeAnimationPayload", () => {
  it("keeps clip name, model, skeleton, duration, and retarget source", () => {
    expect(
      normalizeAnimationPayload({
        clipName: " Walk ",
        modelGuid: " model-1 ",
        skeletonGuid: " skel-1 ",
        durationMs: 1250.4,
        sourceAnimationGuid: " src-1 ",
      }),
    ).toEqual({
      clipName: "Walk",
      modelGuid: "model-1",
      skeletonGuid: "skel-1",
      durationMs: 1250.4,
      clipDurationMs: 1250.4,
      sourceAnimationGuid: "src-1",
    });
  });

  it("keeps an authored Duration apart from the clip's length", () => {
    const authored = normalizeAnimationPayload({ clipName: "Walk", durationMs: 1500, clipDurationMs: 1000 });
    expect([authored.durationMs, authored.clipDurationMs]).toEqual([1500, 1000]);
    const clipOnly = normalizeAnimationPayload({ clipName: "Walk", clipDurationMs: 1000 });
    expect([clipOnly.durationMs, clipOnly.clipDurationMs]).toEqual([1000, 1000]);
    // An invalid clip length falls back to the stored Duration, as for assets saved before it existed.
    const invalidClip = normalizeAnimationPayload({ clipName: "Walk", durationMs: 1250, clipDurationMs: -1 });
    expect([invalidClip.durationMs, invalidClip.clipDurationMs]).toEqual([1250, 1250]);
  });

  it("coerces missing optional guids to null and drops non-positive durations", () => {
    expect(
      normalizeAnimationPayload({ clipName: "Idle" }),
    ).toEqual({
      clipName: "Idle",
      modelGuid: "",
      skeletonGuid: null,
      sourceAnimationGuid: null,
    });
    expect(normalizeAnimationPayload({ clipName: "Idle", durationMs: 0 }).durationMs).toBeUndefined();
  });
});

describe("modelClipAnimationGuidsFromAnimations", () => {
  it("maps native clip names to Animation guids and skips retargeted rows", () => {
    expect(modelClipAnimationGuidsFromAnimations([
        {
          guid: "idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "hero-model",
          }),
        },
        {
          guid: "retargeted",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "hero-model",
            sourceAnimationGuid: "mixamo-idle",
          }),
        },
      ]),
    ).toEqual(new Map([["hero-model", new Map([["Idle", "idle"]])]]));
  });
});

describe("retargetAnimationLoadsFromAnimations", () => {
  it("maps retargeted rows onto the target Model and skips native clips", () => {
    expect(
      retargetAnimationLoadsFromAnimations([
        {
          guid: "native-idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "hero-model",
            skeletonGuid: "hero-skel",
          }),
        },
        {
          guid: "src-idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "mixamo-model",
            skeletonGuid: "mixamo-skel",
          }),
        },
        {
          guid: "retargeted-idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "hero-model",
            skeletonGuid: "hero-skel",
            sourceAnimationGuid: "src-idle",
          }),
        },
      ]),
    ).toEqual(
      new Map([
        [
          "hero-model",
          [
            {
              animationGuid: "retargeted-idle",
              clipName: "Idle",
              sourceModelGuid: "mixamo-model",
            },
          ],
        ],
      ]),
    );
  });
});
