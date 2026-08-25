/**
 * Self-hosted KTX2 transcoder config for Babylon's KhronosTextureContainer2
 * (engineplan §3.5). Never point at a CDN — editor and exports must work offline.
 */

export {
  KTX2_TRANSCODER_RELATIVE_FILES,
  playerFilesHaveKtx2Transcoder,
} from "@babylonslate/assets";

export interface Ktx2TranscoderUrls {
  jsDecoderModule: string;
  jsMSCTranscoder: string;
  wasmMSCTranscoder: string;
  wasmUASTCToASTC: string;
  wasmUASTCToBC7: string;
  wasmUASTCToRGBAUnorm: string;
  wasmUASTCToRGBASrgb: string;
  wasmUASTCToR8Unorm: string;
  wasmUASTCToRG8Unorm: string;
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
    wasmUASTCToRGBAUnorm: `${base}uastc_rgba8_unorm_v2.wasm`,
    wasmUASTCToRGBASrgb: `${base}uastc_rgba8_srgb_v2.wasm`,
    wasmUASTCToR8Unorm: `${base}uastc_r8_unorm.wasm`,
    wasmUASTCToRG8Unorm: `${base}uastc_rg8_unorm.wasm`,
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
    wasmUASTCToRGBA_UNORM: urls.wasmUASTCToRGBAUnorm,
    wasmUASTCToRGBA_SRGB: urls.wasmUASTCToRGBASrgb,
    wasmUASTCToR8_UNORM: urls.wasmUASTCToR8Unorm,
    wasmUASTCToRG8_UNORM: urls.wasmUASTCToRG8Unorm,
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
