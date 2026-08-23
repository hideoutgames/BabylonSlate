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
  | "skybox";

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
 * Editor texture LOD levels (Engine Setting `editorTextureLod`). Graduated
 * caps on the longest edge; sources below EDITOR_TEXTURE_LOD_MIN_SOURCE_EDGE
 * are exempt at every level except `tiny`, which scales everything.
 */
export const EDITOR_TEXTURE_LOD_MIN_SOURCE_EDGE = 256;

/** Longest-edge cap per level. `off` never scales; `tiny` is the extreme floor. */
export const EDITOR_TEXTURE_LOD_CAPS = {
  off: Number.POSITIVE_INFINITY,
  balanced: 1024,
  aggressive: 512,
  minimal: 256,
  tiny: 128,
} as const;

export type EditorTextureLod = keyof typeof EDITOR_TEXTURE_LOD_CAPS;

export const EDITOR_TEXTURE_LOD_LEVELS: readonly EditorTextureLod[] = [
  "off",
  "balanced",
  "aggressive",
  "minimal",
  "tiny",
];

export const DEFAULT_EDITOR_TEXTURE_LOD: EditorTextureLod = "balanced";

export function isEditorTextureLod(value: unknown): value is EditorTextureLod {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EDITOR_TEXTURE_LOD_CAPS, value)
  );
}

/**
 * Effective longest-edge cap for a source under an editor LOD level.
 * Returns the source edge unchanged when the level leaves it untouched
 * (`off`, or the <256px exemption outside `tiny`); otherwise the smaller of
 * source edge and level cap. Pair with clampDimension so non-square sources
 * scale proportionally off their longest edge (never crop/stretch):
 * e.g. 1236×2390 at `balanced` → clampDimension gives 530×1024.
 */
export function editorLodMaxDimension(
  sourceLongestEdge: number,
  level: EditorTextureLod,
): number {
  const edge = Math.max(1, Math.round(sourceLongestEdge));
  if (level === "off") return edge;
  if (level !== "tiny" && edge < EDITOR_TEXTURE_LOD_MIN_SOURCE_EDGE) {
    return edge;
  }
  return Math.min(edge, EDITOR_TEXTURE_LOD_CAPS[level]);
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

/**
 * Read intrinsic image dimensions from container headers — PNG IHDR, JPEG
 * SOFn, and KTX2 (pixelWidth/pixelHeight). Returns null for anything else.
 * Pure sync sniffing so LOD decisions need no image decode.
 */
export function sniffImageSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  // PNG: 8-byte signature, IHDR length/type, width@16 height@20 (u32 BE)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  // JPEG: scan segment markers for the first SOF0-SOF15 frame header
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return sniffJpegSize(bytes);
  }
  // KTX2: 12-byte identifier, vkFormat@12, pixelWidth@20, pixelHeight@24
  if (bytes.length >= 28 && isKtx2Container(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(20, true);
    const height = view.getUint32(24, true);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

function sniffJpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const segLength = view.getUint16(offset + 2);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + segLength;
  }
  return null;
}

function isKtx2Container(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0xab &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x20 &&
    bytes[5] === 0x32 &&
    bytes[6] === 0x32 &&
    bytes[7] === 0xbb &&
    bytes[8] === 0x0d &&
    bytes[9] === 0x0a &&
    bytes[10] === 0x1a &&
    bytes[11] === 0x0a
  );
}

/**
 * Authored per-texture resolution tiers (Texture payload `buildDownsample`).
 * Relative to the longest edge. A non-`source` tier takes precedence over the
 * `editorTextureLod` Engine Setting for that texture everywhere (editor and
 * builds); `source` defers to the Engine Setting (editor) / full-res (builds).
 */
export const BUILD_DOWNSAMPLE_TIERS = [
  "source",
  "1/2",
  "1/3",
  "1/4",
  "1/6",
  "1/8",
  "1/16",
] as const;

export type BuildDownsampleTier = (typeof BUILD_DOWNSAMPLE_TIERS)[number];

export function isBuildDownsampleTier(value: unknown): value is BuildDownsampleTier {
  return (
    typeof value === "string" &&
    (BUILD_DOWNSAMPLE_TIERS as readonly string[]).includes(value)
  );
}

function tierFraction(tier: BuildDownsampleTier): number | null {
  if (tier === "source") return null;
  const [num, den] = tier.split("/");
  const numerator = Number(num);
  const denominator = Number(den);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

/** Longest-edge cap for an authored tier (`source` returns the edge itself). */
export function buildDownsampleCap(
  longestEdge: number,
  tier: BuildDownsampleTier,
): number {
  const edge = Math.max(1, Math.round(longestEdge));
  const fraction = tierFraction(tier);
  if (fraction === null) return edge;
  return Math.max(1, Math.ceil(edge * fraction));
}

/** Standard encoded-variant caps, descending — candidate pool for matching. */
export const STANDARD_ENCODE_CAPS = [4096, 2048, 1024, 512, 256, 128] as const;

export interface TextureCapInput {
  longestEdge: number;
  /** Authored tier from `payload.buildDownsample`. Invalid values ignored. */
  buildDownsample?: unknown;
  /** Legacy absolute cap from old `payload.maxDimension` — kept readable. */
  legacyMaxDimension?: unknown;
  /** Editor LOD level; `undefined` means "no editor downscaling" (exports). */
  lod?: EditorTextureLod;
  /** Project encode ceiling applied to every branch. */
  projectMaxDimension?: number;
}

/**
 * Single precedence implementation shared by editor consumption, variants and
 * exports: authored tier (≠ source) → legacy numeric cap → editor LOD → source
 * edge. Everything clamps to the project ceiling when one is given.
 */
export function textureEffectiveLodCap(input: TextureCapInput): number {
  const edge = Math.max(1, Math.round(input.longestEdge));
  const clampProject = (cap: number): number =>
    typeof input.projectMaxDimension === "number" &&
    Number.isFinite(input.projectMaxDimension) &&
    input.projectMaxDimension > 0
      ? Math.min(cap, input.projectMaxDimension)
      : cap;

  const tier = isBuildDownsampleTier(input.buildDownsample)
    ? input.buildDownsample
    : undefined;
  // `source` means "no authored intent" — defer to legacy cap / editor LOD.
  if (tier && tier !== "source") {
    return clampProject(buildDownsampleCap(edge, tier));
  }

  const legacy =
    typeof input.legacyMaxDimension === "number" &&
    Number.isFinite(input.legacyMaxDimension) &&
    input.legacyMaxDimension > 0
      ? input.legacyMaxDimension
      : null;
  if (legacy !== null) {
    return clampProject(Math.min(edge, Math.round(legacy)));
  }

  if (input.lod && input.lod !== "off") {
    return clampProject(editorLodMaxDimension(edge, input.lod));
  }

  return clampProject(edge);
}
