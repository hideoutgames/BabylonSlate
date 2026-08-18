import type { AnimClipCatalogEntry } from "@babylonslate/anim-graph";
import {
  modelClipAnimationGuidsFromAnimations,
  normalizeAnimationPayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
} from "@babylonslate/assets";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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

/** Build a clip catalog from Content Browser headers (Model clipNames, Animation clipName). */
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
      asset.header.type === "Model" || asset.header.type === "Animation"
        ? nullableGuid(payload.skeletonGuid)
        : undefined;
    const modelGuid =
      asset.header.type === "Animation" ? trimmed(payload.modelGuid) : "";
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

/** Native (non-retargeted) clipName → Animation guid, keyed by owning Model. */
export function modelClipAnimationGuidsFromAssets(
  assets: ReadonlyArray<CatalogAsset>,
): Map<string, Map<string, string>> {
  return modelClipAnimationGuidsFromAnimations(
    assets
      .filter((asset) => asset.header.type === "Animation")
      .map((asset) => ({
        guid: asset.header.guid,
        payload: normalizeAnimationPayload(asset.header.payload),
      })),
  );
}
