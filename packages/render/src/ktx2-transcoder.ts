/**
 * Self-hosted KTX2 transcoder config for Babylon's KhronosTextureContainer2
 * (engineplan §3.5). Never point at a CDN — editor and exports must work offline.
 */

export interface Ktx2TranscoderUrls {
  jsDecoderModule: string;
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
    wasmUASTCToASTC: urls.wasmUASTCToASTC,
    wasmUASTCToBC7: urls.wasmUASTCToBC7,
    wasmZSTDDecoder: urls.wasmZSTDDecoder,
  };
  return urls;
}
