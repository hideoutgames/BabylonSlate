/** Texture compression states (engineplan §3.5). */
export type TextureCompressionState =
  | "pending"
  | "encoding"
  | "compressed"
  | "fallback_uncompressed"
  | "encode_failed";

export type TextureUsage =
  | "albedo"
  | "emissive"
  | "orm"
  | "normal"
  | "sprite"
  | "ui"
  | "font"
  | "pixelArt"
  | "skybox"
  | "particle";

export interface TextureEncodeSettings {
  format: "uastc" | "etc1s";
  quality: number;
  maxDimension: number;
  generateMipmaps: boolean;
  /**
   * Round each encoded base edge up to a multiple of this after the
   * max-dimension clamp. Set only for Particle usage; see
   * {@link textureEncodeBlockAlign}.
   */
  blockAlign?: number;
}

export const DEFAULT_TEXTURE_ENCODE_SETTINGS: TextureEncodeSettings = {
  format: "uastc",
  quality: 2,
  maxDimension: 2048,
  generateMipmaps: true,
};

/** Policy defaults: pixel art / sprites / UI / fonts / skyboxes stay uncompressed. */
export function shouldCompressTexture(usage: TextureUsage | string): boolean {
  return (
    usage !== "pixelArt" &&
    usage !== "sprite" &&
    usage !== "ui" &&
    usage !== "font" &&
    usage !== "skybox"
  );
}

export function clampDimension(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number; clamped: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    return { width, height, clamped: false };
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    clamped: true,
  };
}

/**
 * Compressed GPU block edge. WebGPU rejects ASTC 4x4 / BC7 textures whose
 * base width or height is not a multiple of it, which invalidates the frame.
 */
export const TEXTURE_BLOCK_EDGE = 4;

/** Encode block alignment for a Texture usage: Particle only, else none. */
export function textureEncodeBlockAlign(
  usage: TextureUsage | string,
): number | undefined {
  return usage === "particle" ? TEXTURE_BLOCK_EDGE : undefined;
}

/** Round each edge up to a multiple of `align` (no-op when unset or <= 1). */
export function alignEncodeSize(
  width: number,
  height: number,
  align?: number,
): { width: number; height: number } {
  if (!align || align <= 1) return { width, height };
  return {
    width: Math.ceil(width / align) * align,
    height: Math.ceil(height / align) * align,
  };
}

/**
 * Final encode size: clamp the longest edge to `maxDimension`, then round up
 * to `blockAlign`. The whole image is resampled to this size, so an aligned
 * edge may exceed `maxDimension` (1x1 clamped to 1 encodes at 4x4).
 * `apps/editor/public/basis/encode-worker.js` mirrors this in plain JS.
 */
export function textureEncodeSize(
  width: number,
  height: number,
  settings: Pick<TextureEncodeSettings, "maxDimension" | "blockAlign">,
): { width: number; height: number; clamped: boolean } {
  const clamped = clampDimension(width, height, settings.maxDimension);
  return {
    ...alignEncodeSize(clamped.width, clamped.height, settings.blockAlign),
    clamped: clamped.clamped,
  };
}

/** GPU/encode clamp: min(optional per-asset max, project max). Source size is applied in decode. */
export function effectiveTextureMaxDimension(
  assetMax: unknown,
  projectMax: number,
): number {
  const parsed =
    typeof assetMax === "number" && Number.isFinite(assetMax) && assetMax > 0
      ? assetMax
      : Number.POSITIVE_INFINITY;
  return Math.min(parsed, projectMax);
}

/**
 * Deterministic settings hash used as the KTX2 chunk id suffix so changing
 * encode settings invalidates only the compressed variant. `blockAlign` is
 * keyed only when set so unaligned encodes keep their existing ids.
 */
export async function encodeSettingsHash(
  settings: TextureEncodeSettings,
): Promise<string> {
  const payload = JSON.stringify({
    format: settings.format,
    quality: settings.quality,
    maxDimension: settings.maxDimension,
    generateMipmaps: settings.generateMipmaps,
    ...(settings.blockAlign ? { blockAlign: settings.blockAlign } : {}),
  });
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function ktx2ChunkId(settingsHash: string): string {
  return `ktx2:${settingsHash}`;
}

/**
 * Stub encoder for unit tests and hosts without Basis wasm yet. Writes a
 * recognizable marker payload; the real import Worker swaps this for Basis
 * UASTC + Zstd via transferable source bytes.
 */
export async function stubEncodeKtx2(
  source: Uint8Array,
  settings: TextureEncodeSettings,
): Promise<{ ktx2: Uint8Array; wallMs: number }> {
  const started = performance.now();
  const header = new TextEncoder().encode(
    `BABS-KTX2-STUB;format=${settings.format};q=${settings.quality};max=${settings.maxDimension};`,
  );
  const ktx2 = new Uint8Array(header.byteLength + source.byteLength);
  ktx2.set(header, 0);
  ktx2.set(source, header.byteLength);
  return { ktx2, wallMs: performance.now() - started };
}
