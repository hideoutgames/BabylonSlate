import {
  slimGlbEmbeddedImages,
  shouldSlimModelEmbeddedTextures,
  type PackedTextureSlimProof,
} from "@babylonslate/assets";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/**
 * GLB v2 header whose first chunk is JSON and fits the buffer. The loader
 * parses that JSON itself, so sniffing never decodes it a second time.
 */
function isGlbContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === GLB_MAGIC &&
    view.getUint32(4, true) === 2 &&
    view.getUint32(16, true) === CHUNK_JSON &&
    20 + view.getUint32(12, true) <= bytes.byteLength;
}

/** True when bytes are a GLB or glTF JSON document. OBJ/STL return false. */
export function isGltfModelBytes(
  bytes: Uint8Array | null | undefined,
): boolean {
  if (!bytes || bytes.byteLength < 4) return false;
  if (isGlbContainer(bytes)) return true;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as {
      asset?: unknown;
    };
    return Boolean(json && typeof json === "object" && json.asset);
  } catch {
    return false;
  }
}

/**
 * Copy a babasset / payload `subarray` into a packed buffer. Some glTF paths
 * read `bytes.buffer` without `byteOffset`, so a view into a .babasset file
 * fails to parse.
 */
export function packedGltfBytes(bytes: Uint8Array): Uint8Array {
  const packed =
    bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
  return packed ? bytes : bytes.slice();
}

/** Packed GLB for the loader; slims rasters only when slot textures are packed. */
export function gpuModelBytes(
  bytes: Uint8Array,
  payload?: unknown,
  packedTextures?: PackedTextureSlimProof | null,
): Uint8Array {
  const packed = packedGltfBytes(bytes);
  if (payload && shouldSlimModelEmbeddedTextures(payload, packedTextures)) {
    return slimGlbEmbeddedImages(packed);
  }
  return packed;
}

export function gltfLoaderExtension(bytes: Uint8Array): ".glb" | ".gltf" {
  return isGlbContainer(bytes) ? ".glb" : ".gltf";
}
