/**
 * Self-hosted KTX2 transcoder config for Babylon's KhronosTextureContainer2
 * (engineplan §3.5). Never point at a CDN — editor and exports must work offline.
 */

export interface Ktx2TranscoderUrls {
  jsDecoderModule: string;
  jsMSCTranscoder: string;
  wasmMSCTranscoder: string;
  wasmUASTCToASTC: string;
  wasmUASTCToBC7: string;
  wasmZSTDDecoder: string;
}

export const DEFAULT_KTX2_PUBLIC_BASE = "/ktx2/";

/** Relative player/export paths for every file `ktx2TranscoderUrls` names. */
export const KTX2_TRANSCODER_RELATIVE_FILES = [
  "ktx2/babylon.ktx2Decoder.js",
  "ktx2/msc_basis_transcoder.js",
  "ktx2/msc_basis_transcoder.wasm",
  "ktx2/uastc_astc.wasm",
  "ktx2/uastc_bc7.wasm",
  "ktx2/zstddec.wasm",
] as const;

export function ktx2TranscoderUrls(
  basePath: string = DEFAULT_KTX2_PUBLIC_BASE,
): Ktx2TranscoderUrls {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return {
    jsDecoderModule: `${base}babylon.ktx2Decoder.js`,
    jsMSCTranscoder: `${base}msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${base}msc_basis_transcoder.wasm`,
    wasmUASTCToASTC: `${base}uastc_astc.wasm`,
    wasmUASTCToBC7: `${base}uastc_bc7.wasm`,
    wasmZSTDDecoder: `${base}zstddec.wasm`,
  };
}

export function playerFilesHaveKtx2Transcoder(
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  return KTX2_TRANSCODER_RELATIVE_FILES.every((name) => {
    const bytes = files.get(name);
    return Boolean(bytes && bytes.byteLength > 0);
  });
}

/**
 * Apply URLConfig on a KhronosTextureContainer2-like object. Kept free of a
 * hard Babylon import so unit tests can pass a mock. Values may be nullable on
 * Babylon's static `URLConfig` shape.
 */
export function configureKtx2Transcoder(
  container: { URLConfig: Record<string, string | null> },
  basePath: string = DEFAULT_KTX2_PUBLIC_BASE,
): Ktx2TranscoderUrls {
  const urls = ktx2TranscoderUrls(basePath);
  container.URLConfig = {
    ...container.URLConfig,
    jsDecoderModule: urls.jsDecoderModule,
    jsMSCTranscoder: urls.jsMSCTranscoder,
    wasmMSCTranscoder: urls.wasmMSCTranscoder,
    wasmUASTCToASTC: urls.wasmUASTCToASTC,
    wasmUASTCToBC7: urls.wasmUASTCToBC7,
    wasmZSTDDecoder: urls.wasmZSTDDecoder,
  };
  return urls;
}

/**
 * HEAD/GET every self-hosted transcoder URL (JS and wasm). Used to decide
 * `fallback_uncompressed` and whether export should pack PNG instead of KTX2.
 */
export async function probeKtx2TranscoderAvailable(
  basePath: string = DEFAULT_KTX2_PUBLIC_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const urls = Object.values(ktx2TranscoderUrls(basePath));
  try {
    for (const url of urls) {
      const head = await fetchImpl(url, { method: "HEAD" });
      if (head.ok) continue;
      const get = await fetchImpl(url, { method: "GET" });
      if (!get.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
