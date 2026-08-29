import type { BabassetHeader } from "./babasset";
import { longestEdge, sniffImageSize } from "./image-size";
import {
  authoredTextureMaxDimension,
  isTextureLodExemptUsage,
  resolveTextureTargetEdge,
  textureDownsampleFromPayload,
} from "./texture-lod";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
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
  const encodeBase = options.encodeSettings ?? DEFAULT_TEXTURE_ENCODE_SETTINGS;
  const settings: TextureEncodeSettings = {
    ...encodeBase,
    maxDimension: Math.min(targetEdge, encodeBase.maxDimension),
    quality:
      typeof header.payload.compressionQuality === "number"
        ? header.payload.compressionQuality
        : encodeBase.quality,
  };
  const preferredChunkId = ktx2ChunkId(await encodeSettingsHash(settings));
  const selected = selectTextureChunk(header, {
    preferredChunkId,
  });
  const selectedBytes = await readChunk(selected.chunk.id);
  const lodOn = lod?.enabled === true && !isTextureLodExemptUsage(usage);
  const ktx2MatchesPreferred =
    selected.kind === "ktx2" && selected.chunk.id === preferredChunkId;
  const useSelectedKtx2 =
    Boolean(selectedBytes && selectedBytes.byteLength > 0) &&
    selected.kind === "ktx2" &&
    (!lodOn || ktx2MatchesPreferred);
  if (useSelectedKtx2 && selectedBytes) {
    return {
      bytes: selectedBytes,
      kind: "ktx2",
      chunkId: selected.chunk.id,
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
