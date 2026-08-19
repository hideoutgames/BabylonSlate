import type { Engine, Material, Scene } from "@babylonjs/core";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { DEFAULT_THUMBNAIL_MAX_EDGE, type ModelMaterialSlot } from "@babylonslate/assets";
import {
  applyModelMaterialSlots,
  createModelPreviewScene,
  loadModelPreviewSource,
} from "./model-preview";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { encodeRgbaPng } from "./png-encode";

function rgbaBytesFromReadback(
  buffer: ArrayBuffer | ArrayBufferView,
  byteLength: number,
): Uint8Array | null {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < byteLength) return null;
  return bytes.byteLength === byteLength ? bytes : bytes.subarray(0, byteLength);
}

/**
 * One-shot offscreen capture of a Model GLB with slots applied.
 * Transparent clear so Content Browser `--card` tiles show through.
 */
export async function captureModelThumbnailPng(
  engine: Engine,
  bytes: Uint8Array,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string, scene: Scene) => Material | null,
  maxEdge: number = DEFAULT_THUMBNAIL_MAX_EDGE,
): Promise<Uint8Array | null> {
  const host = createModelPreviewScene(engine, { transparent: true });
  let loaded: { dispose: () => void } | null = null;
  let rtt: RenderTargetTexture | null = null;
  try {
    loaded = await loadModelPreviewSource(host, bytes);
    if (!loaded) return null;
    applyModelMaterialSlots(host.mesh, slots, (guid) =>
      resolveMaterial(guid, host.scene),
    );
    const size = Math.max(1, Math.floor(maxEdge));
    rtt = new RenderTargetTexture(
      "modelThumbnail",
      { width: size, height: size },
      host.scene,
      false,
    );
    host.camera.outputRenderTarget = rtt;
    host.scene.render();
    const buffer = await rtt.readPixels();
    if (!buffer) return null;
    const pixels = rgbaBytesFromReadback(buffer, size * size * 4);
    if (!pixels) return null;
    return encodeRgbaPng(
      size,
      size,
      new Uint8Array(flipReadPixelsRgba(pixels, size, size)),
    );
  } catch {
    return null;
  } finally {
    host.camera.outputRenderTarget = null;
    rtt?.dispose();
    loaded?.dispose();
    host.dispose();
  }
}
