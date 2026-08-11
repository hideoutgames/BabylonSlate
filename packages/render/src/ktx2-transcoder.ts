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
 * HEAD/GET the decoder module URL. Used to decide `fallback_uncompressed`
 * when self-hosted transcoder files are missing (export / bad deploy).
 */
export async function probeKtx2TranscoderAvailable(
  basePath: string = DEFAULT_KTX2_PUBLIC_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const urls = ktx2TranscoderUrls(basePath);
  try {
    const response = await fetchImpl(urls.jsDecoderModule, { method: "HEAD" });
    if (response.ok) return true;
    const get = await fetchImpl(urls.jsDecoderModule, { method: "GET" });
    return get.ok;
  } catch {
    return false;
  }
}
