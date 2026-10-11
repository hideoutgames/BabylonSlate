export const TEXTURE_LOD_FLOOR = 256;
export const TEXTURE_LOD_QUALITY_MIN = 0.25;
export const TEXTURE_LOD_QUALITY_MAX = 1;

export const TEXTURE_DOWNSAMPLE_OPTIONS = [1, 2, 4, 8, 16] as const;
export type TextureDownsample = (typeof TEXTURE_DOWNSAMPLE_OPTIONS)[number];

export function isTextureLodExemptUsage(usage: string): boolean {
  return usage === "skybox" || usage === "pixelArt" || usage === "colorGrading";
}

export function normalizeTextureDownsample(value: unknown): TextureDownsample {
  const parsed = typeof value === "number" ? value : Number(value);
  if (TEXTURE_DOWNSAMPLE_OPTIONS.includes(parsed as TextureDownsample)) {
    return parsed as TextureDownsample;
  }
  return 1;
}

export function textureDownsampleFromPayload(
  payload: Record<string, unknown>,
): TextureDownsample {
  return normalizeTextureDownsample(payload.downsample);
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
