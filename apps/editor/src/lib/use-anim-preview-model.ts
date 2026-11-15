import { useCallback, useMemo } from "react";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  type SkeletonKind,
} from "@haptic/assets";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import type { AnimPreviewClip } from "../components/anim-graph-preview-canvas";
import { useModelSourceBytes } from "./use-model-source-bytes";

/**
 * What a 3D animation preview shows: the Models it can show (those on `skeletonGuid`, or with no Skeleton the Models
 * the Animations come from), the chosen one (else the first) with its file, and each Animation as a clip on it: one of
 * its own, bound from another Model on the Skeleton, or retargeted from its source.
 */
export function useAnimPreviewModel({
  skeletonGuid,
  animationGuids,
  previewModelGuid,
}: {
  skeletonGuid: string | null;
  animationGuids: readonly string[];
  previewModelGuid: string | null;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { readAssetChunk } = useDocumentActions();
  const guidsKey = animationGuids.join("|");
  const models = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    if (skeletonGuid) {
      return assets.filter((asset) =>
        asset.header.type === "Model" && normalizeModelPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid);
    }
    const owners = new Set(guidsKey.split("|").filter(Boolean).flatMap((guid) => {
      const asset = assetRegistry?.getByGuid(guid);
      const modelGuid = asset?.header.type === "Animation" ? normalizeAnimationPayload(asset.header.payload ?? {}).modelGuid : null;
      return modelGuid ? [modelGuid] : [];
    }));
    return assets.filter((asset) => asset.header.type === "Model" && owners.has(asset.header.guid));
  }, [assetRegistry, guidsKey, registryEpoch, skeletonGuid]);
  const model = models.find((asset) => asset.header.guid === previewModelGuid) ?? models[0];
  const modelPayload = model ? normalizeModelPayload(model.header.payload ?? {}) : null;
  const source = useModelSourceBytes(model?.path);
  const skeleton = skeletonGuid ? assetRegistry?.getByGuid(skeletonGuid) : undefined;
  const skeletonKind: SkeletonKind | null = skeleton ? normalizeSkeletonPayload(skeleton.header.payload ?? {}).kind : null;
  const modelGuid = model?.header.guid;
  const clips = useMemo((): AnimPreviewClip[] => {
    void registryEpoch;
    if (!modelGuid) return [];
    return guidsKey.split("|").filter(Boolean).flatMap((guid): AnimPreviewClip[] => {
      const asset = assetRegistry?.getByGuid(guid);
      if (asset?.header.type !== "Animation") return [];
      const animation = normalizeAnimationPayload(asset.header.payload ?? {});
      if (!animation.clipName) return [];
      if (animation.sourceAnimationGuid) {
        const sourceAsset = assetRegistry?.getByGuid(animation.sourceAnimationGuid);
        const sourceModel = sourceAsset?.header.type === "Animation" ? normalizeAnimationPayload(sourceAsset.header.payload ?? {}).modelGuid : null;
        return sourceModel ? [{ animationGuid: guid, clipName: animation.clipName, source: { kind: "retarget", modelGuid: sourceModel } }] : [];
      }
      if (!animation.modelGuid) return [];
      return [{
        animationGuid: guid,
        clipName: animation.clipName,
        source: animation.modelGuid === modelGuid ? { kind: "own" } : { kind: "bind", modelGuid: animation.modelGuid },
      }];
    });
  }, [assetRegistry, guidsKey, modelGuid, registryEpoch]);
  const readModelBytes = useCallback(async (guid: string) => {
    const path = assetRegistry?.getByGuid(guid)?.path;
    const bytes = path ? await readAssetChunk(path, "source") : null;
    if (!bytes) throw new Error(`Model ${guid} has no source to read.`);
    return bytes;
  }, [assetRegistry, readAssetChunk]);
  return { models, model, modelPayload, source, skeletonKind, clips, readModelBytes };
}

export type AnimPreviewModel = ReturnType<typeof useAnimPreviewModel>;
