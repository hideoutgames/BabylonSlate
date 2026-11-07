/** Babylon keeps decoder paths process-wide: the backend Engine and the view must configure the same ones. */
export function playerDecoderPaths(): { ktx2BasePath: string; dracoBasePath: string; meshoptBasePath: string } {
  return {
    ktx2BasePath: new URL("./ktx2/", document.baseURI).href,
    dracoBasePath: new URL("./draco/", document.baseURI).href,
    meshoptBasePath: new URL("./meshopt/", document.baseURI).href,
  };
}

/** A decoder runtime a loaded asset needs at its first decode. */
export type PlayerDecoder = "ktx2" | "ktx2-zstd" | "ktx2-basislz" | "draco" | "meshopt";

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
/** KTX2 `supercompressionScheme`: BasisLZ is ETC1S, which the Basis transcoder decodes; Zstandard wraps UASTC. */
const KTX2_BASISLZ = 1;
const KTX2_ZSTD = 2;

/** The KTX2 decoder a Texture's bytes need, by their supercompression; none for another container. */
export function textureDecoder(bytes: Uint8Array): PlayerDecoder | null {
  if (bytes.byteLength < 48 || KTX2_IDENTIFIER.some((byte, index) => bytes[index] !== byte)) return null;
  const scheme = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(44, true);
  return scheme === KTX2_BASISLZ ? "ktx2-basislz" : scheme === KTX2_ZSTD ? "ktx2-zstd" : "ktx2";
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const glbText = new TextDecoder();

/** The mesh decoders a Model's GLB names in its JSON chunk; none when it uses neither compression. */
export function modelDecoders(glb: Uint8Array): PlayerDecoder[] {
  if (glb.byteLength < 20) return [];
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== GLB_JSON_CHUNK) return [];
  const json = glbText.decode(glb.subarray(20, Math.min(glb.byteLength, 20 + view.getUint32(12, true))));
  return [
    ...(json.includes("KHR_draco_mesh_compression") ? ["draco" as const] : []),
    ...(json.includes("EXT_meshopt_compression") || json.includes("KHR_meshopt_compression") ? ["meshopt" as const] : []),
  ];
}

function decoderFiles(decoder: PlayerDecoder, paths: ReturnType<typeof playerDecoderPaths>): string[] {
  const ktx2 = (file: string) => new URL(file, paths.ktx2BasePath).href;
  switch (decoder) {
    case "ktx2": return [ktx2("babylon.ktx2Decoder.js")];
    case "ktx2-zstd": return [ktx2("babylon.ktx2Decoder.js"), ktx2("zstddec.wasm")];
    case "ktx2-basislz": return [ktx2("babylon.ktx2Decoder.js"), ktx2("msc_basis_transcoder.js"), ktx2("msc_basis_transcoder.wasm")];
    case "draco": return [new URL("draco_wasm_wrapper_gltf.js", paths.dracoBasePath).href, new URL("draco_decoder_gltf.wasm", paths.dracoBasePath).href];
    case "meshopt": return [new URL("meshopt_decoder.js", paths.meshoptBasePath).href];
  }
}

/**
 * Fetch each needed decoder's files once, at low priority, while the game
 * downloads, so the HTTP cache holds them when the first decode asks. A UASTC
 * Texture's GPU target is known only once the Engine exists, so its target
 * transcoder is left to that decode. Failures are ignored: the decode reports
 * a missing file itself.
 */
export function createDecoderPrefetch(
  fetchImpl: typeof fetch = fetch,
  paths: ReturnType<typeof playerDecoderPaths> = playerDecoderPaths(),
): (decoder: PlayerDecoder) => void {
  const requested = new Set<string>();
  return (decoder) => {
    for (const url of decoderFiles(decoder, paths)) {
      if (requested.has(url)) continue;
      requested.add(url);
      void fetchImpl(url, { priority: "low" } as RequestInit)
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
    }
  };
}
