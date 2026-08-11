export type TextureFormat = "rgba8" | "astc4x4";

export const BYTES_PER_TEXEL: Record<TextureFormat, number> = {
  rgba8: 4,
  astc4x4: 1,
};

/**
 * Self-computed accounted bytes (Safari has no performance.memory).
 * Mipmaps add roughly one third of the base size.
 */
export function accountedTextureBytes(
  width: number,
  height: number,
  format: TextureFormat,
  withMips: boolean,
): number {
  const base = width * height * BYTES_PER_TEXEL[format];
  return withMips ? Math.ceil(base * (4 / 3)) : base;
}
