import type { BabassetHeader } from "./babasset";
import { isEnvironmentTexturePayload, readEnvironmentTextureInfo } from "./environment-texture";
import { longestEdge, sniffImageSize, type ImageSize } from "./image-size";
import {
  authoredTextureMaxDimension,
  isTextureLodExemptUsage,
  resolveTextureTargetEdge,
  textureDownsampleFromPayload,
} from "./texture-lod";
import { isKtx2BlockAligned } from "./ktx2-info";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  TEXTURE_BLOCK_EDGE,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  textureEncodeBlockAlign,
  textureEncodeSize,
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
    // Particle Textures bind only a block-aligned KTX2 (WebGPU rejects others).
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

/**
 * KTX2 encode settings for a Texture payload under `usage`: Compression
 * Quality, the Downsample and project clamp, and Particle block alignment.
 * `project` holds the project encode settings (`maxDimension` is the project
 * max). The registry queues every encode with these settings.
 */
export function textureEncodeSettingsFor(
  payload: Record<string, unknown>,
  project: TextureEncodeSettings,
  usage: string = String(payload.usage ?? "albedo"),
): TextureEncodeSettings {
  const quality =
    typeof payload.compressionQuality === "number" &&
    Number.isFinite(payload.compressionQuality)
      ? payload.compressionQuality
      : project.quality;
  const blockAlign = textureEncodeBlockAlign(usage);
  return {
    ...project,
    quality,
    maxDimension: authoredEncodeMaxDimension(payload, project.maxDimension),
    ...(blockAlign ? { blockAlign } : {}),
  };
}

/**
 * Base size of this Texture's KTX2 encode under `usage` (its own by default),
 * from the header's source size, else `sourceSize` (the decoded size of its
 * `pixels` chunk: Textures extracted from a Model store no header size). The
 * settings still come from the payload, as the encoder builds them. Null when
 * neither size is known.
 */
export function textureEncodeBaseSize(
  payload: Record<string, unknown>,
  projectMax: number,
  usage: string = String(payload.usage ?? "albedo"),
  sourceSize?: ImageSize | null,
): { width: number; height: number } | null {
  const source =
    positiveSize(payload.width, payload.height) ??
    (sourceSize ? positiveSize(sourceSize.width, sourceSize.height) : null);
  if (!source) return null;
  const settings = textureEncodeSettingsFor(
    payload,
    { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, maxDimension: projectMax },
    usage,
  );
  const size = textureEncodeSize(source.width, source.height, settings);
  return { width: size.width, height: size.height };
}

function positiveSize(width: unknown, height: unknown): ImageSize | null {
  return typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

/**
 * The encoded base size when a compressed Texture would not load on WebGPU
 * (ASTC / BC7 need whole 4x4 blocks), so Particle Usage is needed; null when
 * it loads (Particle, uncompressed Usages, environment cubes, aligned sizes)
 * or its size is unknown. `sourceSize` sizes a header without one
 * (`textureEncodeBaseSize`).
 */
export function textureNeedsParticleUsage(
  payload: Record<string, unknown>,
  projectMax: number,
  sourceSize?: ImageSize | null,
): { width: number; height: number } | null {
  const usage = String(payload.usage ?? "albedo");
  if (
    usage === "particle" ||
    !shouldCompressTexture(usage) ||
    isEnvironmentTexturePayload(payload)
  ) {
    return null;
  }
  const size = textureEncodeBaseSize(payload, projectMax, usage, sourceSize);
  if (!size) return null;
  const aligned =
    size.width % TEXTURE_BLOCK_EDGE === 0 &&
    size.height % TEXTURE_BLOCK_EDGE === 0;
  return aligned ? null : size;
}
