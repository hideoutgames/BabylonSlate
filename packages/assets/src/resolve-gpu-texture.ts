import type { BabassetHeader } from "./babasset";
import { isEnvironmentTexturePayload, readEnvironmentTextureInfo } from "./environment-texture";
import { longestEdge, sniffImageSize } from "./image-size";
import {
  authoredTextureMaxDimension,
  isTextureLodExemptUsage,
  resolveTextureTargetEdge,
  textureDownsampleFromPayload,
} from "./texture-lod";
import { isKtx2BlockAligned } from "./ktx2-info";
import {
  clampDimension,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
  textureEncodeBlockAlign,
  textureEncodePadding,
  type TextureEncodeSettings,
} from "./texture-compression";
import { selectTextureChunk } from "./texture-loader";

export interface EditorTextureLod {
  enabled: boolean;
  quality: number;
}

export interface ResolveGpuTextureOptions {
  header: BabassetHeader;
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  editorLod?: EditorTextureLod | null;
  encodeSettings?: TextureEncodeSettings;
}

export interface ResolvedGpuTexture {
  bytes: Uint8Array;
  kind: "ktx2" | "source";
  chunkId: string;
  targetEdge: number;
  sourceEdge: number;
  preferredChunkId: string | null;
  missingPreferred: boolean;
}

async function readPixelsOrSource(
  header: BabassetHeader,
  readChunk: (chunkId: string) => Promise<Uint8Array | null>,
): Promise<{ bytes: Uint8Array; chunkId: string } | null> {
  const pixels = header.chunks.find(
    (chunk) => chunk.id === "pixels" || chunk.kind === "pixels",
  );
  if (pixels) {
    const bytes = await readChunk(pixels.id);
    if (bytes && bytes.byteLength > 0) return { bytes, chunkId: pixels.id };
  }
  const source = header.chunks.find(
    (chunk) => chunk.id === "source" || chunk.kind === "source",
  );
  if (source) {
    const bytes = await readChunk(source.id);
    if (bytes && bytes.byteLength > 0) return { bytes, chunkId: source.id };
  }
  return null;
}

export async function resolveGpuTexture(
  options: ResolveGpuTextureOptions,
): Promise<ResolvedGpuTexture | null> {
  const { header, readChunk } = options;
  if (isEnvironmentTexturePayload(header.payload)) {
    const selected = selectTextureChunk(header);
    const bytes = await readChunk(selected.chunk.id);
    if (!bytes?.byteLength) return null;
    const info = readEnvironmentTextureInfo(bytes);
    return { bytes, kind: "source", chunkId: selected.chunk.id, sourceEdge: info.width, targetEdge: info.width, preferredChunkId: null, missingPreferred: false };
  }
  const raster = await readPixelsOrSource(header, readChunk);
  const sniffed =
    (raster ? sniffImageSize(raster.bytes) : null) ??
    (typeof header.payload.width === "number" &&
    typeof header.payload.height === "number"
      ? {
          width: header.payload.width,
          height: header.payload.height,
        }
      : null);
  const sourceEdge =
    longestEdge(sniffed) ??
    DEFAULT_TEXTURE_ENCODE_SETTINGS.maxDimension;
  const downsample = textureDownsampleFromPayload(header.payload, sourceEdge);
  const usage = String(header.payload.usage ?? "albedo");
  const lod = options.editorLod;
  const targetEdge = resolveTextureTargetEdge({
    sourceEdge,
    downsample,
    lodEnabled: lod?.enabled === true,
    lodQuality: lod?.quality ?? 1,
    usage,
  });
  // Changing Usage must take effect even when a previous encode is retained.
  if (usage === "pixelArt" && raster) {
    return {
      bytes: raster.bytes,
      kind: "source",
      chunkId: raster.chunkId,
      targetEdge,
      sourceEdge,
      preferredChunkId: null,
      missingPreferred: false,
    };
  }
  const encodeBase = options.encodeSettings ?? DEFAULT_TEXTURE_ENCODE_SETTINGS;
  const blockAlign = textureEncodeBlockAlign(usage);
  const settings: TextureEncodeSettings = {
    ...encodeBase,
    maxDimension: Math.min(targetEdge, encodeBase.maxDimension),
    quality:
      typeof header.payload.compressionQuality === "number"
        ? header.payload.compressionQuality
        : encodeBase.quality,
    ...(blockAlign ? { blockAlign } : {}),
  };
  const preferredChunkId = ktx2ChunkId(await encodeSettingsHash(settings));
  const selected = selectTextureChunk(header, {
    preferredChunkId,
  });
  let selectedChunkId = selected.chunk.id;
  let selectedBytes = await readChunk(selectedChunkId);
  if (blockAlign && selected.kind === "ktx2") {
    // Particle Textures bind only a block-aligned KTX2, the size Particle encodes at.
    // A retained encode from an earlier Usage may be selected first; try the
    // committed encode before falling back to source pixels.
    const committed = header.payload.ktx2ChunkId;
    if (
      !(selectedBytes && isKtx2BlockAligned(selectedBytes, blockAlign)) &&
      typeof committed === "string" &&
      committed !== selectedChunkId &&
      header.chunks.some((chunk) => chunk.id === committed)
    ) {
      selectedChunkId = committed;
      selectedBytes = await readChunk(committed);
    }
    if (!(selectedBytes && isKtx2BlockAligned(selectedBytes, blockAlign))) {
      selectedBytes = null;
    }
  }
  const lodOn = lod?.enabled === true && !isTextureLodExemptUsage(usage);
  const ktx2MatchesPreferred =
    selected.kind === "ktx2" && selectedChunkId === preferredChunkId;
  const useSelectedKtx2 =
    Boolean(selectedBytes && selectedBytes.byteLength > 0) &&
    selected.kind === "ktx2" &&
    (!lodOn || ktx2MatchesPreferred);
  if (useSelectedKtx2 && selectedBytes) {
    return {
      bytes: selectedBytes,
      kind: "ktx2",
      chunkId: selectedChunkId,
      targetEdge,
      sourceEdge,
      preferredChunkId,
      missingPreferred: !ktx2MatchesPreferred,
    };
  }
  if (
    selectedBytes &&
    selectedBytes.byteLength > 0 &&
    selected.kind !== "ktx2"
  ) {
    return {
      bytes: selectedBytes,
      kind: "source",
      chunkId: selected.chunk.id,
      targetEdge,
      sourceEdge,
      preferredChunkId,
      missingPreferred: true,
    };
  }
  if (!raster) return null;
  return {
    bytes: raster.bytes,
    kind: "source",
    chunkId: raster.chunkId,
    targetEdge,
    sourceEdge,
    preferredChunkId,
    missingPreferred: true,
  };
}

export function authoredEncodeMaxDimension(
  payload: Record<string, unknown>,
  projectMax: number,
  sourceEdge?: number,
): number {
  const edge =
    sourceEdge ??
    (typeof payload.width === "number" && typeof payload.height === "number"
      ? Math.max(payload.width, payload.height)
      : projectMax);
  const downsample = textureDownsampleFromPayload(payload, edge);
  return Math.min(
    projectMax,
    authoredTextureMaxDimension({ sourceEdge: edge, downsample }),
  );
}

export interface TextureEncodeContext {
  /** A Tileset, Sprite or Sprite Animation samples the texture. */
  atlas?: boolean;
  /** Source pixel size when the payload has none (sniffed from the source bytes). */
  sourceSize?: { width: number; height: number } | null;
  /** Clamp override that replaces the authored Downsample and project clamp. */
  maxDimension?: number;
}

/**
 * KTX2 encode settings for a Texture payload under `usage`: Compression
 * Quality, the Downsample and project clamp, and block alignment
 * ({@link textureEncodePadding}: padded off the 4-texel grid unless an
 * atlas; Particle always). `project` holds the project encode settings
 * (`maxDimension` is the project max). The registry queues every encode with
 * these settings and commits it under {@link textureEncodeChunkId}.
 */
export function textureEncodeSettingsFor(
  payload: Record<string, unknown>,
  project: TextureEncodeSettings,
  usage: string = String(payload.usage ?? "albedo"),
  context: TextureEncodeContext = {},
): TextureEncodeSettings {
  const quality =
    typeof payload.compressionQuality === "number" &&
    Number.isFinite(payload.compressionQuality)
      ? payload.compressionQuality
      : project.quality;
  const maxDimension =
    context.maxDimension ?? authoredEncodeMaxDimension(payload, project.maxDimension);
  const source = payloadPixelSize(payload) ?? context.sourceSize ?? null;
  const clamped = source ? clampDimension(source.width, source.height, maxDimension) : null;
  const { blockAlign: _projectAlign, ...base } = project;
  void _projectAlign;
  const blockAlign = textureEncodePadding(usage, { atlas: context.atlas === true, clampedSize: clamped });
  return {
    ...base,
    quality,
    maxDimension,
    ...(blockAlign ? { blockAlign } : {}),
  };
}

/** Authored source size from an image import (`payload.width` / `height`). */
export function payloadPixelSize(
  payload: Record<string, unknown>,
): { width: number; height: number } | null {
  const { width, height } = payload;
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : null;
}
