/**
 * Self-hosted KTX2 transcoder config for Babylon's KhronosTextureContainer2
 * (engineplan §3.5). Never point at a CDN — editor and exports must work offline.
 */

import {
  KTX2_TRANSCODER_RELATIVE_FILES,
  playerFilesHaveKtx2Transcoder,
} from "@babylonslate/assets";

export {
  KTX2_TRANSCODER_RELATIVE_FILES,
  playerFilesHaveKtx2Transcoder,
};

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

export type Ktx2DecoderRuntimeContainer = {
  DefaultNumWorkers: number;
  DefaultDecoderOptions: {
    forceRGBA: boolean | undefined;
    useRGBAIfASTCBC7NotAvailableWhenUASTC: boolean | undefined;
  };
};

export type Ktx2DecoderRuntimeOptions = {
  /**
   * Packed player / Preview iframe: decode on this thread so wasm URLs are
   * not loaded from a blob Worker (COEP / importScripts often fail there).
   * Also forces uncompressed RGBA — software GL often advertises ASTC then
   * fails texImage2D.
   */
  mainThread?: boolean;
  /** Engine compressed-texture caps. Missing ASTC and BC7 → uncompressed RGBA. */
  caps?: { astc?: unknown; bptc?: unknown };
  /** `engine.getGlInfo().renderer` — software GL often lies about ASTC/S3TC. */
  renderer?: string;
};

const SOFTWARE_GL_RENDERER =
  /swiftshader|llvmpipe|softpipe|microsoft basic render|\bsoftware\b/i;

export function isSoftwareGlRenderer(renderer: string): boolean {
  return SOFTWARE_GL_RENDERER.test(renderer);
}

/** Uncompressed RGBA when compressed upload would fail (missing caps or software GL). */
export function shouldForceKtx2Rgba(
  caps?: { astc?: unknown; bptc?: unknown },
  renderer?: string,
): boolean {
  if (isSoftwareGlRenderer(renderer ?? "")) return true;
  return !caps?.astc && !caps?.bptc;
}

/**
 * Preview Build always packs PNG/pixels so a cold iframe matches overlay Play.
 * Hardware GPUs still pack KTX2 for itch Export Game via {@link shouldPackKtx2Textures}.
 */
export function shouldPackKtx2ForPreviewBuild(): boolean {
  return false;
}

/**
 * Whether packed Texture bytes should be KTX2.
 * Preview Build always uses PNG/pixels. Export Game uses KTX2 when the player
 * has the transcoder and the editor GPU is not software GL.
 */
export function shouldPackKtx2Textures(
  playerFiles: ReadonlyMap<string, Uint8Array>,
  renderer?: string,
): boolean {
  return (
    playerFilesHaveKtx2Transcoder(playerFiles) &&
    !isSoftwareGlRenderer(renderer ?? "")
  );
}

/**
 * After Engine construction: pick a transcode target the GPU can upload.
 * Software WebGL often advertises S3TC/ASTC then fails `texImage2D`.
 */
export function configureKtx2DecoderRuntime(
  container: Ktx2DecoderRuntimeContainer,
  options: Ktx2DecoderRuntimeOptions = {},
): void {
  if (options.mainThread) {
    container.DefaultNumWorkers = 0;
  }
  container.DefaultDecoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC = true;
  container.DefaultDecoderOptions.forceRGBA =
    options.mainThread === true ||
    shouldForceKtx2Rgba(options.caps, options.renderer);
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
