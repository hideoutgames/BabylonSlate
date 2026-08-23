import {
  DEFAULT_EDITOR_TEXTURE_LOD,
  editorLodMaxDimension,
  isBuildDownsampleTier,
  isEditorTextureLod,
  sniffImageSize,
  type EditorTextureLod,
} from "@babylonslate/assets";
import { createAppSettingsStore } from "@babylonslate/vfs";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "../lib/viewport-render-gate";

/** Usages that must stay pixel-crisp or full-res regardless of LOD. */
export const LOD_EXEMPT_USAGES = new Set(["pixelArt", "skybox"]);

/**
 * Editor texture LOD level (Engine Setting). Memoized between changes:
 * Engine Settings change rarely, and collectors run on every edit.
 */
let editorTextureLodCache: { value: EditorTextureLod } | null = null;

export async function currentEditorTextureLod(): Promise<EditorTextureLod> {
  if (editorTextureLodCache) return editorTextureLodCache.value;
  let value: EditorTextureLod = DEFAULT_EDITOR_TEXTURE_LOD;
  try {
    const settings = await createAppSettingsStore().load();
    if (isEditorTextureLod(settings.editorTextureLod)) {
      value = settings.editorTextureLod;
    }
  } catch {
    // fall through to default
  }
  editorTextureLodCache = { value };
  return value;
}

if (typeof window !== "undefined") {
  window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, () => {
    editorTextureLodCache = null;
  });
}

/**
 * Upload-time downscale for uncompressed-policy textures (sprites / UI / fonts
 * / compression fallbacks). One uniform longest-edge factor — identical math
 * to the KTX2 variant path — so aspect ratio never breaks. Returns null when
 * the level leaves the texture untouched or the platform cannot decode.
 */
export async function downscaleTextureBytesForLod(
  bytes: Uint8Array,
  lod: EditorTextureLod,
  usage: string,
): Promise<Uint8Array | null> {
  if (lod === "off" || LOD_EXEMPT_USAGES.has(usage)) return null;
  if (typeof createImageBitmap !== "function") return null;
  try {
    const source = sniffImageSize(bytes);
    if (!source) return null;
    const longest = Math.max(source.width, source.height);
    const cap = editorLodMaxDimension(longest, lod);
    if (cap >= longest) return null;
    const scale = cap / longest;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const bitmap = await createImageBitmap(
      new Blob([
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ]),
    );
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const out = new Uint8Array(await blob.arrayBuffer());
      return out.byteLength > 0 ? out : null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** Minimal surface of ProjectService the resolver needs. */
export interface EditorTextureByteService {
  readBestTextureChunk(
    guid: string,
    options?: { lod?: EditorTextureLod },
  ): Promise<{
    bytes: Uint8Array;
    mime?: string;
    kind: "ktx2" | "pixels" | "source";
    clampedByLod: boolean;
  } | null>;
  readAssetChunk(path: string, chunkId: string): Promise<Uint8Array | null>;
}

export interface EditorTextureAssetRef {
  path: string;
  guid: string;
  payload: Record<string, unknown>;
}

/**
 * Single precedence implementation for every editor texture consumer:
 * authored tier (`buildDownsample` ≠ source) beats legacy caps beats
 * `editorTextureLod`.
 *
 * - `"engine"` surfaces may receive KTX2 bytes (Babylon decodes them).
 * - `"dom"` surfaces never receive KTX2 — browsers cannot decode it in <img>;
 *   they get downscaled raw pixels (or raw fallbacks untouched).
 */
export async function loadEditorTextureBytes(
  service: EditorTextureByteService,
  asset: EditorTextureAssetRef,
  options: { surface?: "engine" | "dom"; lod?: EditorTextureLod } = {},
): Promise<Uint8Array | null> {
  const surface = options.surface ?? "engine";
  const lod = options.lod ?? (await currentEditorTextureLod());
  const usage = String(asset.payload?.usage ?? "albedo");

  if (surface === "engine") {
    const best = await service.readBestTextureChunk(asset.guid, { lod });
    if (best && best.bytes.byteLength > 0) {
      if (best.kind === "ktx2") return best.bytes;
      if (best.kind === "pixels") {
        const downscaled = await downscaleTextureBytesForLod(
          best.bytes,
          lod,
          usage,
        );
        return downscaled ?? best.bytes;
      }
      // kind === "source": fall through to the raw pixels path below.
    }
  }

  const pixels = await service.readAssetChunk(asset.path, "pixels");
  if (pixels && pixels.byteLength > 0) {
    const downscaled = await downscaleTextureBytesForLod(pixels, lod, usage);
    return downscaled ?? pixels;
  }
  const source = await service.readAssetChunk(asset.path, "source");
  if (source && source.byteLength > 0) return source;
  return null;
}
