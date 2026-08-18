import { describe, expect, it } from "vitest";
import {
  animClipCatalogFromAssets,
  modelClipAnimationGuidsFromAssets,
} from "./anim-clip-catalog";

describe("animClipCatalogFromAssets", () => {
  it("reads Model clipNames and Animation clipName from payload", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "hero-model",
            type: "Model",
            name: "Hero",
            dependencies: ["hero-walk"],
            payload: { clipNames: ["Idle", "Walk"] },
          },
        },
        {
          header: {
            guid: "hero-walk",
            type: "Animation",
            name: "Hero_Walk",
            payload: { clipName: "Walk" },
          },
        },
      ]),
    ).toEqual([
      {
        guid: "hero-model",
        type: "Model",
        name: "Hero",
        clipName: undefined,
        clipNames: ["Idle", "Walk"],
        dependencyGuids: ["hero-walk"],
      },
      {
        guid: "hero-walk",
        type: "Animation",
        name: "Hero_Walk",
        clipName: "Walk",
        clipNames: [],
        dependencyGuids: [],
      },
    ]);
  });

  it("reads Animation skeleton, model, and duration from payload", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "hero-model",
            type: "Model",
            name: "Hero",
            payload: { skeletonGuid: "hero-skel" },
          },
        },
        {
          header: {
            guid: "hero-walk",
            type: "Animation",
            name: "Hero_Walk",
            payload: {
              clipName: "Walk",
              modelGuid: "hero-model",
              skeletonGuid: "hero-skel",
              durationMs: 1800,
            },
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        guid: "hero-model",
        skeletonGuid: "hero-skel",
      }),
      expect.objectContaining({
        guid: "hero-walk",
        clipName: "Walk",
        modelGuid: "hero-model",
        skeletonGuid: "hero-skel",
        durationMs: 1800,
      }),
    ]);
  });

  it("drops non-string clipNames and ignores a non-object payload", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "model",
            type: "Model",
            name: "Hero",
            payload: { clipNames: ["Idle", 2, null, "Walk"] },
          },
        },
        {
          header: {
            guid: "anim",
            type: "Animation",
            name: "Clip",
            payload: "not-an-object",
          },
        },
      ]),
    ).toEqual([
      {
        guid: "model",
        type: "Model",
        name: "Hero",
        clipName: undefined,
        clipNames: ["Idle", "Walk"],
        dependencyGuids: [],
      },
      {
        guid: "anim",
        type: "Animation",
        name: "Clip",
        clipName: undefined,
        clipNames: [],
        dependencyGuids: [],
      },
    ]);
  });

  it("reads Sprite Animation durationMs from header payload", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "walk-anim",
            type: "SpriteAnimation",
            name: "Walk",
            payload: { durationMs: 250 },
          },
        },
      ]),
    ).toEqual([
      {
        guid: "walk-anim",
        type: "SpriteAnimation",
        name: "Walk",
        clipName: undefined,
        clipNames: [],
        dependencyGuids: [],
        durationMs: 250,
      },
    ]);
  });

  it("sums Sprite Animation frame durations when header durationMs is missing", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "walk-anim",
            type: "SpriteAnimation",
            name: "Walk",
            payload: {
              frames: [{ durationMs: 100 }, { durationMs: 150 }],
            },
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        guid: "walk-anim",
        durationMs: 250,
      }),
    ]);
  });

  it("sums Sprite Animation global frameDurationMs when frames do not override", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "walk-anim",
            type: "SpriteAnimation",
            name: "Walk",
            payload: {
              frameDurationMs: 40,
              frames: [{ textureGuid: "a" }, { textureGuid: "b" }],
            },
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        guid: "walk-anim",
        durationMs: 80,
      }),
    ]);
  });

  it("maps native Model clip names to Animation guids and skips retargeted rows", () => {
    expect(
      modelClipAnimationGuidsFromAssets([
        {
          header: {
            guid: "idle",
            type: "Animation",
            name: "Hero_Idle",
            payload: {
              clipName: "Idle",
              modelGuid: "hero-model",
            },
          },
        },
        {
          header: {
            guid: "retargeted",
            type: "Animation",
            name: "Mixamo_Idle",
            payload: {
              clipName: "Idle",
              modelGuid: "hero-model",
              sourceAnimationGuid: "mixamo-idle",
            },
          },
        },
      ]),
    ).toEqual(
      new Map([["hero-model", new Map([["Idle", "idle"]])]]),
    );
  });
});
