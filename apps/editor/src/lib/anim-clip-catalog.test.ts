import { describe, expect, it } from "vitest";
import { animClipCatalogFromAssets } from "./anim-clip-catalog";

describe("animClipCatalogFromAssets", () => {
  it("reads the Animation clipName from payload and lists Models by name only", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "hero-model",
            type: "Model",
            name: "Hero",
            dependencies: ["hero-walk"],
            payload: {},
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
        dependencyGuids: ["hero-walk"],
      },
      {
        guid: "hero-walk",
        type: "Animation",
        name: "Hero_Walk",
        clipName: "Walk",
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

  it("ignores a non-object payload", () => {
    expect(
      animClipCatalogFromAssets([
        {
          header: {
            guid: "model",
            type: "Model",
            name: "Hero",
            payload: {},
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
        dependencyGuids: [],
      },
      {
        guid: "anim",
        type: "Animation",
        name: "Clip",
        clipName: undefined,
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
              frameDurationMs: 100,
              frames: [{ durationMs: 100 }, { durationMs: 150, durationMsOverride: true }],
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

  it("lists a Blend Space with its Skeleton, axes and samples", () => {
    const [entry] = animClipCatalogFromAssets([
      {
        header: {
          guid: "bs",
          type: "BlendSpace",
          name: "BS_Loco",
          payload: {
            skeletonGuid: "rig",
            axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0.2, wrap: false }],
            samples: [{ animationGuid: "walk", x: 2, y: 0, rateScale: 1 }],
          },
        },
      },
    ]);
    expect(entry).toMatchObject({
      guid: "bs",
      type: "BlendSpace",
      skeletonGuid: "rig",
      blendSpace: {
        axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0.2, wrap: false }],
        samples: [{ animationGuid: "walk", x: 2, y: 0, rateScale: 1 }],
      },
    });
  });
});
