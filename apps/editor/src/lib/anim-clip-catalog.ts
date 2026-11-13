import type { AnimClipCatalogEntry } from "@haptic/anim-graph";
import {
  normalizeBlendSpacePayload,
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
    const blendSpace = asset.header.type === "BlendSpace" ? normalizeBlendSpacePayload(payload) : undefined;
    const modelGuid =
      asset.header.type === "Animation" ? trimmed(payload.modelGuid) : "";
    const frameCount =
      asset.header.type === "SpriteAnimation" && Array.isArray(payload.frames) && payload.frames.length > 0
        ? payload.frames.length
        : undefined;
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
      ...(blendSpace ? { blendSpace: { axes: blendSpace.axes, samples: blendSpace.samples } } : {}),
    };
  });
}
