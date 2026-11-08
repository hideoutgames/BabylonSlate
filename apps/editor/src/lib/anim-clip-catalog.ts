import type { AnimClipCatalogEntry } from "@haptic/anim-graph";
import {
  normalizeAnimationPayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
} from "@haptic/assets";
import { asRecord } from "./as-record";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function nullableGuid(value: unknown): string | null {
  const guid = typeof value === "string" ? value.trim() : "";
  return guid.length > 0 ? guid : null;
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

/** Build a clip catalog from Content Browser headers (Model clipNames, Animation clipName). */
export function animClipCatalogFromAssets(
  assets: ReadonlyArray<CatalogAsset>,
): AnimClipCatalogEntry[] {
  return assets.map((asset) => {
    const payload = asRecord(asset.header.payload);
    const animation =
      asset.header.type === "Animation" ? normalizeAnimationPayload(payload) : null;
    const durationMs =
      asset.header.type === "SpriteAnimation"
        ? spriteAnimationCatalogDuration(payload)
        : animation?.durationMs;
    const skeletonGuid = animation
      ? animation.skeletonGuid
      : asset.header.type === "Model"
        ? nullableGuid(payload.skeletonGuid)
        : undefined;
    const modelGuid = animation?.modelGuid ?? "";
    return {
      guid: asset.header.guid,
      type: asset.header.type,
      name: asset.header.name,
      clipName:
        typeof payload.clipName === "string" ? payload.clipName : undefined,
      clipNames: stringList(payload.clipNames),
      dependencyGuids: asset.header.dependencies ?? [],
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(skeletonGuid ? { skeletonGuid } : {}),
      ...(modelGuid ? { modelGuid } : {}),
    };
  });
}
