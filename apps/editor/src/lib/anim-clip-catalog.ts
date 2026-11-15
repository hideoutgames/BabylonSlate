import type { AnimClipCatalogEntry } from "@haptic/anim-graph";
import {
  animationClipEvents,
  normalizeAnimationPayload,
  normalizeModelPayload,
  scaledAnimationRootMotion,
  spriteAnimationClipEvents,
  normalizeBlendSpacePayload,
  normalizeSpriteBlendSpacePayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
} from "@haptic/assets";
import { asRecord } from "./as-record";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableGuid(value: unknown): string | null {
  const guid = trimmed(value);
  return guid.length > 0 ? guid : null;
}

function optionalDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function spriteAnimationCatalogDuration(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
    return Math.max(1, payload.durationMs);
  }
  if (!Array.isArray(payload.frames)) return undefined;
  return spriteAnimationDurationMs(parseSpriteAnimationPayload(payload));
}

type CatalogAsset = {
  header: {
    guid: string;
    type: string;
    name: string;
    dependencies?: string[];
    payload?: unknown;
  };
};

/**
 * Build a clip catalog from Content Browser headers: Animation and Sprite Animation clips, the Models and Skeletons an
 * Animation names, and Blend Spaces with their Skeleton, axes and samples.
 */
export function animClipCatalogFromAssets(
  assets: ReadonlyArray<CatalogAsset>,
): AnimClipCatalogEntry[] {
  // Root motion travels in its source Model's units: each Animation's track scales by that Model's import scale.
  const importScales = new Map<string, number>();
  for (const asset of assets) {
    if (asset.header.type === "Model") importScales.set(asset.header.guid, normalizeModelPayload(asset.header.payload).importScale);
  }
  return assets.map((asset) => {
    const payload = asRecord(asset.header.payload);
    const durationMs =
      asset.header.type === "SpriteAnimation"
        ? spriteAnimationCatalogDuration(payload)
        : asset.header.type === "Animation"
          ? optionalDurationMs(payload.durationMs)
          : undefined;
    const skeletonGuid =
      asset.header.type === "Model" || asset.header.type === "Animation" || asset.header.type === "BlendSpace"
        ? nullableGuid(payload.skeletonGuid)
        : undefined;
    const blendSpace = asset.header.type === "BlendSpace"
      ? normalizeBlendSpacePayload(payload)
      : asset.header.type === "SpriteBlendSpace"
        ? normalizeSpriteBlendSpacePayload(payload)
        : undefined;
    const modelGuid =
      asset.header.type === "Animation" ? trimmed(payload.modelGuid) : "";
    const frameCount =
      asset.header.type === "SpriteAnimation" && Array.isArray(payload.frames) && payload.frames.length > 0
        ? payload.frames.length
        : undefined;
    // The events a player of this clip fires: an Animation's, or a Sprite Animation's frame events at their frames.
    const additive = asset.header.type === "Animation" ? normalizeAnimationPayload(payload).additive : undefined;
    const sourceRootMotion = asset.header.type === "Animation" ? normalizeAnimationPayload(payload).rootMotion : undefined;
    const rootMotion = sourceRootMotion ? scaledAnimationRootMotion(sourceRootMotion, importScales.get(modelGuid) ?? 1) : undefined;
    const events =
      asset.header.type === "Animation"
        ? animationClipEvents(normalizeAnimationPayload(payload).events)
        : asset.header.type === "SpriteAnimation"
          ? spriteAnimationClipEvents(parseSpriteAnimationPayload(payload))
          : [];
    return {
      guid: asset.header.guid,
      type: asset.header.type,
      name: asset.header.name,
      clipName:
        typeof payload.clipName === "string" ? payload.clipName : undefined,
      dependencyGuids: asset.header.dependencies ?? [],
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(frameCount !== undefined ? { frameCount } : {}),
      ...(skeletonGuid ? { skeletonGuid } : {}),
      ...(modelGuid ? { modelGuid } : {}),
      ...(events.length > 0 ? { events } : {}),
      ...(additive ? { additive } : {}),
      ...(rootMotion ? { rootMotion } : {}),
      ...(blendSpace
        ? {
            blendSpace: {
              axes: blendSpace.axes,
              samples: blendSpace.samples,
              ...("hysteresis" in blendSpace
                ? { hysteresis: blendSpace.hysteresis, keepTime: blendSpace.keepTime }
                : { eventMode: blendSpace.eventMode }),
            },
          }
        : {}),
    };
  });
}
