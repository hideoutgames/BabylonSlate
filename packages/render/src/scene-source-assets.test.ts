import { describe, expect, it } from "vitest";
import { normalizeModelPayload } from "@haptic/assets";
import { mergeSceneSourceAssets } from "./scene-source-assets";

const model = (skeletonGuid: string | null) => normalizeModelPayload({ skeletonGuid });

describe("mergeSceneSourceAssets", () => {
  it("gives the Models a first source installed the clips an Animation loaded later brings with its own source", () => {
    // The Scene's sources: the Knight, and a clip library on the Knight's Skeleton whose Idle it plays by name.
    const scene = {
      assets: {
        modelPayloads: new Map([["knight", model("rig")], ["library", model("rig")], ["crate", model(null)]]),
        modelClipAnimationGuids: new Map([["library", new Map([["Idle", "idle-anim"]])]]),
        retargetAnimationLoads: new Map([["knight", [{ animationGuid: "idle-anim", clipName: "Idle", sourceModelGuid: "library", bindByName: true as const }]]]),
      },
    };
    // Play Slot Animation loads Throw: its source holds Throw, its library Model and nothing of the Knight.
    const throwClip = {
      assets: {
        modelPayloads: new Map([["library", model("rig")]]),
        modelClipAnimationGuids: new Map([["library", new Map([["Throw", "throw-anim"]])]]),
        retargetAnimationLoads: new Map(),
      },
    };
    const merged = mergeSceneSourceAssets([scene, throwClip]).assets!;
    expect([...merged.modelClipAnimationGuids!.get("library")!]).toEqual([["Idle", "idle-anim"], ["Throw", "throw-anim"]]);
    expect(merged.retargetAnimationLoads!.get("knight")).toEqual([
      { animationGuid: "idle-anim", clipName: "Idle", sourceModelGuid: "library", bindByName: true },
      { animationGuid: "throw-anim", clipName: "Throw", sourceModelGuid: "library", bindByName: true },
    ]);
    // A Model on no Skeleton, or the library itself, plays no other file's clips.
    expect(merged.retargetAnimationLoads!.has("crate")).toBe(false);
    expect(merged.retargetAnimationLoads!.has("library")).toBe(false);
    // Releasing the later source takes its clips away again.
    const released = mergeSceneSourceAssets([scene]).assets!;
    expect([...released.modelClipAnimationGuids!.get("library")!]).toEqual([["Idle", "idle-anim"]]);
    expect(released.retargetAnimationLoads!.get("knight")!.map((load) => load.animationGuid)).toEqual(["idle-anim"]);
  });

  it("keeps a retargeted Animation's load for its target Model from any source", () => {
    const retarget = { animationGuid: "hero-run", clipName: "Run", sourceModelGuid: "mixamo" };
    const merged = mergeSceneSourceAssets([
      { assets: { modelPayloads: new Map([["hero", model(null)]]), retargetAnimationLoads: new Map() } },
      { assets: { modelPayloads: new Map([["hero", model(null)], ["mixamo", model(null)]]), retargetAnimationLoads: new Map([["hero", [retarget]]]) } },
    ]).assets!;
    expect(merged.retargetAnimationLoads!.get("hero")).toEqual([retarget]);
  });
});
