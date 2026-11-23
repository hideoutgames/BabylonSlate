import type { AnimClipCatalogEntry, AnimClipRootMotion } from "@haptic/anim-graph";
import {
  animationClipEvents,
  animationRootMotionBone,
  normalizeAnimationPayload,
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
 * Animation names, and Blend Spaces with their Skeleton, axes and samples. An Animation's root motion is only its bone
 * (`animationHeaderSummary`), which previews hold in place; Play and export catalogs come from documents, with the track.
 */
export function animClipCatalogFromAssets(
  assets: ReadonlyArray<CatalogAsset>,
): AnimClipCatalogEntry[] {
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
    const animation = asset.header.type === "Animation" ? normalizeAnimationPayload(payload) : undefined;
    const additive = animation?.additive;
    const rootMotionBone = animation ? animationRootMotionBone(payload) : null;
    // The events a player of this clip fires: an Animation's, or a Sprite Animation's frame events at their frames.
    const events =
      animation
        ? animationClipEvents(animation.events)
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
      ...(rootMotionBone ? { rootMotion: { bone: rootMotionBone } } : {}),
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

/**
 * A Play session's clip catalog: every clip the headers list, each Animation's root motion taken from `prepared` (the
 * Play closure's catalog, built from the documents preparation read, its travel scaled by the source Model's import
 * scale as export scales it). An Animation outside the closure has none and costs no read: a slot that plays one loads
 * it on demand first, and the load brings its track in the source union's catalog.
 */
export function playAnimClipCatalog(
  assets: ReadonlyArray<CatalogAsset>,
  prepared: ReadonlyArray<AnimClipCatalogEntry>,
): AnimClipCatalogEntry[] {
  const tracks = new Map<string, AnimClipRootMotion>();
  for (const entry of prepared) if (entry.type === "Animation" && entry.rootMotion?.track) tracks.set(entry.guid, entry.rootMotion);
  return animClipCatalogFromAssets(assets).map((entry) => {
    if (entry.type !== "Animation") return entry;
    const rootMotion = tracks.get(entry.guid);
    if (rootMotion) return { ...entry, rootMotion };
    if (!entry.rootMotion) return entry;
    const { rootMotion: _bone, ...rest } = entry;
    void _bone;
    return rest;
  });
}
