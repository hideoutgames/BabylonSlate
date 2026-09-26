import {
  slimGlbEmbeddedImages,
  shouldSlimModelEmbeddedTextures,
  type PackedTextureSlimProof,
} from "@babylonslate/assets";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function splitGlb(bytes: Uint8Array): {
  json: Record<string, unknown>;
  bin: Uint8Array | null;
} | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, 0) !== GLB_MAGIC) return null;
  if (readU32(view, 4) !== 2) return null;
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = readU32(view, offset);
    const chunkType = readU32(view, offset + 4);
    offset += 8;
    if (offset + chunkLength > bytes.byteLength) break;
    const chunk = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength + pad4(chunkLength);
    if (chunkType === CHUNK_JSON) {
      try {
        json = JSON.parse(new TextDecoder().decode(chunk)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    } else if (chunkType === CHUNK_BIN) {
      bin = chunk;
    }
  }
  return json ? { json, bin } : null;
}

/** True when bytes are a GLB or glTF JSON document. OBJ/STL return false. */
export function isGltfModelBytes(
  bytes: Uint8Array | null | undefined,
): boolean {
  if (!bytes || bytes.byteLength < 4) return false;
  if (splitGlb(bytes)) return true;
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
  return splitGlb(bytes) ? ".glb" : ".gltf";
}
