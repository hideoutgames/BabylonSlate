/**
 * Self-hosted KTX2 transcoder config for Babylon's KhronosTextureContainer2
 * (engineplan §3.5). Never point at a CDN — editor and exports must work offline.
 */

import {
  KTX2_TRANSCODER_RELATIVE_FILES,
  playerFilesHaveKtx2Transcoder,
  sniffKtx2Size,
  TEXTURE_BLOCK_EDGE,
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
   * Execution thread does not select the upload format; actual GPU capabilities
   * and the software-renderer fallback below determine that separately.
   */
  mainThread?: boolean;
  /** Engine compressed-texture caps. Missing ASTC and BC7 → uncompressed RGBA. */
  caps?: { astc?: unknown; bptc?: unknown };
  /** `engine.getGlInfo().renderer` — software GL often lies about ASTC/S3TC. */
  renderer?: string;
};

/** Babylon's worker count before any main-thread configuration replaced it. */
const workerDefaults = new WeakMap<Ktx2DecoderRuntimeContainer, number>();

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
 * Base size of a KTX2 that WebGPU would reject, else null. Unless RGBA is
 * forced, Babylon transcodes Basis KTX2 (vkFormat 0) to a 4x4 block format
 * when ASTC or BC7 is available, and WebGPU requires such a texture's base
 * size in whole blocks (the decoder pads mip data, not `pixelWidth`). WebGL2
 * uploads the same texture, so only WebGPU refuses it.
 */
export function webGpuKtx2BlockMisalignment(
  engine: { isWebGPU: boolean; getCaps(): { astc?: unknown; bptc?: unknown } },
  header: Uint8Array,
  decoder: { forceRGBA?: boolean },
): { width: number; height: number } | null {
  if (!engine.isWebGPU || decoder.forceRGBA) return null;
  const size = sniffKtx2Size(header);
  if (!size || (size.width % TEXTURE_BLOCK_EDGE === 0 && size.height % TEXTURE_BLOCK_EDGE === 0)) return null;
  const vkFormat = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(12, true);
  const caps = engine.getCaps();
  return vkFormat === 0 && (caps.astc || caps.bptc) ? size : null;
}

/** Diagnostic code for a texture skipped by {@link webGpuKtx2BlockMisalignment}. */
export const TEXTURE_BLOCK_SIZE_DIAGNOSTIC = "texture.webgpuBlockSize";

export interface TextureBlockSizeDiagnostic {
  code: typeof TEXTURE_BLOCK_SIZE_DIAGNOSTIC;
  assetGuid: string;
  /** KTX2 base size WebGPU rejected. */
  width: number;
  height: number;
  /** A particle-domain Material samples it. */
  particle: boolean;
  /** A Material of another domain samples it, or a Sprite, Tilemap or 2D texture binds it. */
  other: boolean;
}

/**
 * User-facing explanation and fix for a skipped texture. `particle`: a
 * particle-domain Material samples it (Particle Usage block-aligns the
 * encode); `other`: another Material samples it or a Sprite, Tilemap or 2D
 * texture binds it, which only resizing fixes.
 */
export function textureBlockSizeMessage(texture: {
  name: string;
  width: number;
  height: number;
  particle?: boolean;
  other?: boolean;
}): string {
  const fix = !texture.particle ? "Resize the image to a multiple of 4 pixels."
    : texture.other ? "Set its Usage to Particle, or resize the image to a multiple of 4 pixels."
    : "Set its Usage to Particle.";
  return `Texture "${texture.name}" (${texture.width}×${texture.height}) was not drawn: WebGPU needs compressed textures in multiples of 4 pixels. ${fix}`;
}

/**
 * Preview Build always packs PNG/pixels so a cold iframe matches overlay Play.
 * Itch Export Game still packs KTX2 when the player files contain the
 * transcoder ({@link playerFilesHaveKtx2Transcoder}).
 */
export function shouldPackKtx2ForPreviewBuild(): boolean {
  return false;
}

/**
 * After Engine construction: pick a transcode target the GPU can upload.
 * Software WebGL often advertises S3TC/ASTC then fails `texImage2D`.
 */
export function configureKtx2DecoderRuntime(
  container: Ktx2DecoderRuntimeContainer,
  options: Ktx2DecoderRuntimeOptions = {},
): void {
  if (!workerDefaults.has(container)) {
    workerDefaults.set(container, container.DefaultNumWorkers);
  }
  // Best effort: Babylon fixes the thread mode at the page's first KTX2 decode.
  container.DefaultNumWorkers = options.mainThread
    ? 0
    : workerDefaults.get(container)!;
  container.DefaultDecoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC = true;
  container.DefaultDecoderOptions.forceRGBA =
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
