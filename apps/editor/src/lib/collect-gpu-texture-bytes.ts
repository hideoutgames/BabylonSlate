import {
  resolveGpuTexture,
  type BabassetHeader,
  type EditorTextureLod,
} from "@babylonslate/assets";

export type GpuTextureAsset = {
  path: string;
  header: BabassetHeader;
};

export async function collectGpuTextureBytes(options: {
  assets: readonly GpuTextureAsset[];
  guids: readonly string[];
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  editorLod?: EditorTextureLod | null;
  downsampleSource?: (
    bytes: Uint8Array,
    targetEdge: number,
  ) => Promise<Uint8Array>;
  onMissingKtx2?: (guid: string) => void;
  /** Tileset / sprite texture guids: source PNG, skip LOD and KTX2. */
  pixelArtGuids?: ReadonlySet<string>;
}): Promise<Map<string, Uint8Array>> {
  const byGuid = new Map(
    options.assets.map((asset) => [asset.header.guid, asset] as const),
  );
  const bytes = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const guid of options.guids) {
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const asset = byGuid.get(guid);
    if (!asset || asset.header.type !== "Texture") continue;
    const forcePixelArt = options.pixelArtGuids?.has(guid) === true;
    const resolved = await resolveGpuTexture({
      header: asset.header,
      readChunk: (chunkId) => options.readChunk(asset.path, chunkId),
      editorLod: options.editorLod,
      forcePixelArt,
    });
    if (!resolved) continue;
    if (resolved.missingPreferred) options.onMissingKtx2?.(guid);
    let payload = resolved.bytes;
    if (
      !forcePixelArt &&
      resolved.kind !== "ktx2" &&
      resolved.targetEdge < resolved.sourceEdge &&
      options.downsampleSource
    ) {
      try {
        payload = await options.downsampleSource(
          resolved.bytes,
          resolved.targetEdge,
        );
      } catch {
        payload = resolved.bytes;
      }
    }
    bytes.set(guid, payload);
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
