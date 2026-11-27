import { describe, expect, it } from "vitest";
import { installAssetBytes, normalizeModelPayload } from "@haptic/assets";
import { isSceneSourceAssetsSubset, mergeSceneSourceAssets } from "./scene-source-assets";

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

describe("isSceneSourceAssetsSubset", () => {
  it("treats identical byte content and structurally equal asset metadata as a subset", () => {
    const texBytes = new Uint8Array([1, 2, 3, 4]);
    const modelBytes = new Uint8Array([5, 6, 7, 8]);
    const installed = mergeSceneSourceAssets([{
      assets: {
        textureBytes: new Map([["tex-a", installAssetBytes(texBytes, "image/png")]]),
        modelSources: new Map([["mod-a", installAssetBytes(modelBytes, "model/gltf-binary")]]),
        modelPayloads: new Map([["mod-a", model("rig-1")]]),
        texturePixelSizes: new Map([["tex-a", { width: 64, height: 64 }]]),
        sortingLayers: ["Default"],
        pixelsPerUnit: 100,
      },
      fonts: [{ guid: "font-a", family: "Sans", bytes: new Uint8Array([9, 10]) }],
    }]);
    // Fresh Blob wrappers and freshly normalized metadata for the same assets must still be a subset.
    const sameSubset = mergeSceneSourceAssets([{
      assets: {
        textureBytes: new Map([["tex-a", installAssetBytes(texBytes.slice(), "image/png")]]),
        modelSources: new Map([["mod-a", installAssetBytes(modelBytes.slice(), "model/gltf-binary")]]),
        modelPayloads: new Map([["mod-a", model("rig-1")]]),
        texturePixelSizes: new Map([["tex-a", { width: 64, height: 64 }]]),
        sortingLayers: ["Default"],
        pixelsPerUnit: 100,
      },
      fonts: [{ guid: "font-a", family: "Sans", bytes: new Uint8Array([9, 10]) }],
    }]);
    expect(isSceneSourceAssetsSubset(sameSubset, installed)).toBe(true);

    // Introducing a new asset, changed byte content, or a new animation clip is not a subset.
    const newAsset = mergeSceneSourceAssets([{
      assets: { textureBytes: new Map([["tex-b", installAssetBytes(texBytes, "image/png")]]) },
    }]);
    expect(isSceneSourceAssetsSubset(newAsset, installed)).toBe(false);

    const changedBytes = mergeSceneSourceAssets([{
      assets: { textureBytes: new Map([["tex-a", installAssetBytes(new Uint8Array([4, 3, 2, 1]), "image/png")]]) },
    }]);
    expect(isSceneSourceAssetsSubset(changedBytes, installed)).toBe(false);

    const newClip = mergeSceneSourceAssets([{
      assets: {
        modelPayloads: new Map([["mod-a", model("rig-1")]]),
        modelClipAnimationGuids: new Map([["mod-a", new Map([["Walk", "walk-guid"]])]]),
      },
    }]);
    expect(isSceneSourceAssetsSubset(newClip, installed)).toBe(false);
  });
});
