import { GLTF_MESH_DECODER_RELATIVE_FILES, KTX2_TRANSCODER_RELATIVE_FILES, isKtx2Bytes } from "@haptic/assets";

/** KTX2 `supercompressionScheme` (header offset 44): BasisLZ is ETC1S; UASTC is stored plain or with Zstd. */
const KTX2_SUPERCOMPRESSION_OFFSET = 44;
const BASIS_LZ = 1;
const ZSTD = 2;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const decoder = new TextDecoder();

function ktx2Files(match: (name: string) => boolean): string[] {
  return KTX2_TRANSCODER_RELATIVE_FILES.filter((path) => match(path.slice(path.lastIndexOf("/") + 1)));
}

/**
 * The transcoder files a KTX2 texture decodes with: the decoder module and, for UASTC, Zstd when
 * supercompressed and the small per-GPU target transcoders; the large ETC1S (Basis) transcoder only
 * for an ETC1S texture.
 */
export function ktx2DecoderFiles(bytes: Uint8Array): string[] {
  if (!isKtx2Bytes(bytes) || bytes.byteLength < KTX2_SUPERCOMPRESSION_OFFSET + 4) return [];
  const scheme = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(KTX2_SUPERCOMPRESSION_OFFSET, true);
  if (scheme === BASIS_LZ) return ktx2Files((name) => name === "babylon.ktx2Decoder.js" || name.startsWith("msc_basis_transcoder."));
  return ktx2Files((name) => name === "babylon.ktx2Decoder.js" || name.startsWith("uastc_") || (scheme === ZSTD && name === "zstddec.wasm"));
}

/** The mesh decoder files a GLB needs: only for the compression extensions its JSON chunk lists in `extensionsUsed`. */
export function glbDecoderFiles(source: Uint8Array): string[] {
  if (source.byteLength < 20) return [];
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== GLB_JSON_CHUNK) return [];
  const length = view.getUint32(12, true);
  if (20 + length > source.byteLength) return [];
  const text = decoder.decode(source.subarray(20, 20 + length));
  // Most GLBs use neither: skip parsing their JSON again.
  if (!text.includes("KHR_draco_mesh_compression") && !text.includes("EXT_meshopt_compression")) return [];
  let used: unknown;
  try { used = (JSON.parse(text) as { extensionsUsed?: unknown }).extensionsUsed; } catch { return []; }
  if (!Array.isArray(used)) return [];
  return GLTF_MESH_DECODER_RELATIVE_FILES.filter((path) =>
    path.startsWith("draco/") ? used.includes("KHR_draco_mesh_compression") : used.includes("EXT_meshopt_compression"));
}

export type DecoderPrefetch = {
  /** A texture's bytes as read: a KTX2 one starts fetching the transcoder files it decodes with. */
  texture: (bytes: Uint8Array) => void;
  /** A Model's GLB source: a Draco or meshopt one starts fetching its decoder. */
  model: (source: Uint8Array) => void;
};

/**
 * Starts fetching the decoder runtimes a load will need while its assets still download, so the
 * HTTP cache holds them when the first decode asks Babylon for them. Each file is fetched once;
 * a failed prefetch is ignored, and the decode then fetches the file itself as before.
 */
export function createDecoderPrefetch(baseUrl: string, fetchImpl: typeof fetch = fetch): DecoderPrefetch {
  const requested = new Set<string>();
  const prefetch = (paths: readonly string[]) => {
    for (const path of paths) {
      if (requested.has(path)) continue;
      requested.add(path);
      void fetchImpl(new URL(path, baseUrl).href)
        .then((response) => (response.ok ? response.arrayBuffer() : undefined))
        .catch(() => undefined);
    }
  };
  return {
    texture: (bytes) => prefetch(ktx2DecoderFiles(bytes)),
    model: (source) => prefetch(glbDecoderFiles(source)),
  };
}
