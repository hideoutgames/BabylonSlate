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
      sourceAnimationGuid: "src-1",
    });
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
