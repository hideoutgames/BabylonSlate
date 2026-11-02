import {
  createLimiter,
  mapBounded,
  resolveGpuTexture,
  type HassetHeader,
  type EditorTextureLod,
} from "@haptic/assets";
import { materialParameterTextureGuidsFromGraph, type SerializedGraph } from "@haptic/core";
import { COLLECTOR_READS } from "./play-content";

export type GpuTextureAsset = {
  path: string;
  header: HassetHeader;
};

export async function collectGpuTextureBytes(options: {
  assets: readonly GpuTextureAsset[];
  guids: readonly string[];
  /** Gameplay graphs may select textures that no Material samples at startup. */
  graphs?: readonly SerializedGraph[];
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  editorLod?: EditorTextureLod | null;
  downsampleSource?: (
    bytes: Uint8Array,
    targetEdge: number,
  ) => Promise<Uint8Array>;
  onMissingKtx2?: (guid: string) => void;
}): Promise<Map<string, Uint8Array>> {
  const byGuid = new Map(
    options.assets.map((asset) => [asset.header.guid, asset] as const),
  );
  const bytes = new Map<string, Uint8Array>();
  const textures = [...new Set([
    ...options.guids,
    ...(options.graphs ?? []).flatMap(materialParameterTextureGuidsFromGraph),
  ])].flatMap((guid) => {
    const asset = guid ? byGuid.get(guid) : undefined;
    return asset && asset.header.type === "Texture" ? [{ guid, asset }] : [];
  });
  // Reads overlap; a source downsample decodes a whole image, so those run one at a time.
  const downsample = createLimiter(1);
  const resolved = await mapBounded(textures, COLLECTOR_READS, async ({ guid, asset }) => {
    const texture = await resolveGpuTexture({
      header: asset.header,
      readChunk: (chunkId) => options.readChunk(asset.path, chunkId),
      editorLod: options.editorLod,
    });
    if (!texture) return null;
    if (texture.missingPreferred) options.onMissingKtx2?.(guid);
    if (
      texture.kind !== "ktx2" &&
      texture.targetEdge < texture.sourceEdge &&
      options.downsampleSource
    ) {
      try {
        const resize = options.downsampleSource;
        return await downsample(() => resize(texture.bytes, texture.targetEdge));
      } catch {
        return texture.bytes;
      }
    }
    return texture.bytes;
  });
  for (const [index, { guid }] of textures.entries()) {
    const payload = resolved[index];
    if (payload) bytes.set(guid, payload);
  }
  return bytes;
}

/** Authored Texture payload size. Independent of editor LOD / packed GPU bytes. */
export function texturePixelSizesFromHeaders(
  assets: readonly GpuTextureAsset[],
  guids: readonly string[],
): Map<string, { width: number; height: number }> {
  const byGuid = new Map(
    assets.map((asset) => [asset.header.guid, asset] as const),
  );
  const sizes = new Map<string, { width: number; height: number }>();
  const seen = new Set<string>();
  for (const guid of guids) {
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const asset = byGuid.get(guid);
    if (!asset || asset.header.type !== "Texture") continue;
    const width = Number(asset.header.payload.width);
    const height = Number(asset.header.payload.height);
    if (!(width > 0) || !(height > 0)) continue;
    sizes.set(guid, { width, height });
  }
  return sizes;
}
