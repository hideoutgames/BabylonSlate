export const TEXTURE_LOD_FLOOR = 256;
export const TEXTURE_LOD_QUALITY_MIN = 0.25;
export const TEXTURE_LOD_QUALITY_MAX = 1;
export const TEXTURE_LOD_QUALITY_DEFAULT = 0.5;

export const TEXTURE_DOWNSAMPLE_OPTIONS = [1, 2, 4, 8, 16] as const;
export type TextureDownsample = (typeof TEXTURE_DOWNSAMPLE_OPTIONS)[number];

export function isTextureLodExemptUsage(usage: string): boolean {
  return usage === "skybox" || usage === "pixelArt";
}

export function normalizeTextureDownsample(value: unknown): TextureDownsample {
  const parsed = typeof value === "number" ? value : Number(value);
  if (TEXTURE_DOWNSAMPLE_OPTIONS.includes(parsed as TextureDownsample)) {
    return parsed as TextureDownsample;
  }
  return 1;
}

export function migrateMaxDimensionToDownsample(
  maxDimension: unknown,
  sourceEdge: number,
): TextureDownsample {
  if (
    typeof maxDimension !== "number" ||
    !Number.isFinite(maxDimension) ||
    maxDimension <= 0 ||
    !Number.isFinite(sourceEdge) ||
    sourceEdge <= 0
  ) {
    return 1;
  }
  if (maxDimension >= sourceEdge) return 1;
  const ratio = sourceEdge / maxDimension;
  let best: TextureDownsample = 1;
  let bestDelta = Math.abs(ratio - 1);
  for (const option of TEXTURE_DOWNSAMPLE_OPTIONS) {
    const delta = Math.abs(ratio - option);
    if (delta < bestDelta) {
      best = option;
      bestDelta = delta;
    }
  }
  return best;
}

export function textureDownsampleFromPayload(
  payload: Record<string, unknown>,
  sourceEdge?: number,
): TextureDownsample {
  if (payload.downsample !== undefined && payload.downsample !== null) {
    return normalizeTextureDownsample(payload.downsample);
  }
  if (typeof sourceEdge === "number" && Number.isFinite(sourceEdge)) {
    return migrateMaxDimensionToDownsample(payload.maxDimension, sourceEdge);
  }
  return 1;
}

export function authoredTextureMaxDimension(options: {
  sourceEdge: number;
  downsample: number;
}): number {
  const source = Math.max(1, Math.round(options.sourceEdge));
  const downsample = normalizeTextureDownsample(options.downsample);
  return Math.max(1, Math.round(source / downsample));
}

export function resolveTextureTargetEdge(options: {
  sourceEdge: number;
  downsample: number;
  lodEnabled: boolean;
  lodQuality: number;
  usage: string;
}): number {
  const source = Math.max(1, Math.round(options.sourceEdge));
  const authored = authoredTextureMaxDimension({
    sourceEdge: source,
    downsample: options.downsample,
  });
  const applyLod =
    options.lodEnabled && !isTextureLodExemptUsage(options.usage);
  const quality = applyLod
    ? Math.min(
        TEXTURE_LOD_QUALITY_MAX,
        Math.max(TEXTURE_LOD_QUALITY_MIN, options.lodQuality),
      )
    : 1;
  const lodEdge = Math.round(source * quality);
  const reduced = Math.min(source, authored, lodEdge);
  const floor = Math.min(source, TEXTURE_LOD_FLOOR);
  return Math.min(source, Math.max(reduced, floor));
}
