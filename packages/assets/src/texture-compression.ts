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
  | "pixelArt";

export interface TextureEncodeSettings {
  format: "uastc" | "etc1s";
  quality: number;
  maxDimension: number;
  generateMipmaps: boolean;
}

export const DEFAULT_TEXTURE_ENCODE_SETTINGS: TextureEncodeSettings = {
  format: "uastc",
  quality: 2,
  maxDimension: 2048,
  generateMipmaps: true,
};

/** Policy defaults: pixel art / sprites / UI / fonts stay uncompressed. */
export function shouldCompressTexture(usage: TextureUsage | string): boolean {
  return (
    usage !== "pixelArt" &&
    usage !== "sprite" &&
    usage !== "ui" &&
    usage !== "font"
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
 * Deterministic settings hash used as the KTX2 chunk id suffix so changing
 * encode settings invalidates only the compressed variant.
 */
export async function encodeSettingsHash(
  settings: TextureEncodeSettings,
): Promise<string> {
  const payload = JSON.stringify({
    format: settings.format,
    quality: settings.quality,
    maxDimension: settings.maxDimension,
    generateMipmaps: settings.generateMipmaps,
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
