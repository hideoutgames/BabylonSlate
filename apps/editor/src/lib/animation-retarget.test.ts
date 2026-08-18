import { describe, expect, it } from "vitest";
import { normalizeAnimationPayload } from "@babylonslate/assets";
import {
  retargetedAnimationImport,
  retargetedAnimationName,
  retargetedAnimationPayload,
  writeRetargetedAnimations,
} from "./animation-retarget";

describe("retargetedAnimationPayload", () => {
  it("points the new Animation at the target Skeleton and records the source guid", () => {
    expect(
      retargetedAnimationPayload({
        source: normalizeAnimationPayload({
          clipName: "Idle",
          modelGuid: "src-model",
          skeletonGuid: "src-skel",
          durationMs: 1800,
        }),
        sourceGuid: "src-anim",
        targetSkeletonGuid: "dst-skel",
        targetModelGuid: "dst-model",
      }),
    ).toEqual({
      clipName: "Idle",
      modelGuid: "dst-model",
      skeletonGuid: "dst-skel",
      durationMs: 1800,
      sourceAnimationGuid: "src-anim",
    });
  });
});

describe("retargetedAnimationName", () => {
  it("allocates a unique copy name from the source and target Skeleton names", () => {
    expect(retargetedAnimationName("Hero_Idle", "Mannequin_Skeleton", [])).toBe(
      "Hero_Idle_Mannequin_Skeleton",
    );
    expect(
      retargetedAnimationName("Hero_Idle", "Mannequin_Skeleton", [
        "Hero_Idle_Mannequin_Skeleton",
      ]),
    ).toBe("Hero_Idle_Mannequin_Skeleton_1");
  });
});

describe("retargetedAnimationImport", () => {
  it("creates a header-only Animation ImportResult for createAsset", () => {
    const result = retargetedAnimationImport({
      name: "Hero_Idle_Mannequin_Skeleton",
      guid: "new-anim",
      payload: normalizeAnimationPayload({
        clipName: "Idle",
        modelGuid: "dst-model",
        skeletonGuid: "dst-skel",
        sourceAnimationGuid: "src-anim",
      }),
    });
    expect(result).toMatchObject({
      type: "Animation",
      name: "Hero_Idle_Mannequin_Skeleton",
      guid: "new-anim",
      dependencies: ["dst-model", "dst-skel", "src-anim"],
      chunks: [],
    });
    expect(result.payload.sourceAnimationGuid).toBe("src-anim");
  });
});

describe("writeRetargetedAnimations", () => {
  it("skips createAsset when the probe finds no matching channels", async () => {
    const created: string[] = [];
    const result = await writeRetargetedAnimations({
      sources: [
        {
          guid: "src-anim",
          name: "Hero_Idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "src-model",
            skeletonGuid: "src-skel",
          }),
        },
      ],
      targetSkeletonGuid: "dst-skel",
      targetSkeletonName: "Mannequin_Skeleton",
      targetModelGuid: "dst-model",
      existingNames: [],
      folderRelative: "assets",
      rootId: "project",
      readModelBytes: async () => new Uint8Array([1]),
      probeMatches: async () => false,
      createAsset: async (_rootId, relativePath) => {
        created.push(relativePath);
      },
    });
    expect(created).toEqual([]);
    expect(result.skipped).toEqual(["Hero_Idle"]);
    expect(result.created).toBe(0);
  });

  it("writes a new Animation when the probe finds matching channels", async () => {
    const created: string[] = [];
    const result = await writeRetargetedAnimations({
      sources: [
        {
          guid: "src-anim",
          name: "Hero_Idle",
          payload: normalizeAnimationPayload({
            clipName: "Idle",
            modelGuid: "src-model",
            skeletonGuid: "src-skel",
            durationMs: 900,
          }),
        },
      ],
      targetSkeletonGuid: "dst-skel",
      targetSkeletonName: "Mannequin_Skeleton",
      targetModelGuid: "dst-model",
      existingNames: [],
      folderRelative: "assets",
      rootId: "project",
      readModelBytes: async () => new Uint8Array([1]),
      probeMatches: async () => true,
      createAsset: async (_rootId, relativePath, importResult) => {
        created.push(relativePath);
        expect(importResult.payload).toMatchObject({
          clipName: "Idle",
          modelGuid: "dst-model",
          skeletonGuid: "dst-skel",
          sourceAnimationGuid: "src-anim",
        });
      },
    });
    expect(created).toEqual(["assets/Hero_Idle_Mannequin_Skeleton.babasset"]);
    expect(result.skipped).toEqual([]);
    expect(result.created).toBe(1);
  });
});
