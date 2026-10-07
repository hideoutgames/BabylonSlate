import type { AnimationGroup, AbstractEngine, Material, Scene } from "@babylonjs/core";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import {
  DEFAULT_THUMBNAIL_MAX_EDGE,
  type ModelMaterialSlot,
} from "@babylonslate/assets";
import {
  applyModelMaterialSlots,
  createModelPreviewScene,
  loadModelPreviewSource,
  previewRigRoot,
} from "./model-preview";
import {
  aimPreviewCameraAtMesh,
  createPreviewRenderTarget,
  renderPreviewFrame,
  type MaterialPreviewScene,
} from "./material-preview";
import { retargetAnimationGroupWithMeshProxy } from "./node-rig";
import { waitForPreviewMeshesReady } from "./preview-readiness";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { encodeRgbaPng } from "./png-encode";
import { nativePreparationForEngine } from "./native-preparation";

type ModelThumbnailOptions = {
  importScale?: number;
  clipName?: string;
  sourceClipBytes?: Uint8Array | null;
  signal?: AbortSignal;
};

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
  return bytes.byteLength === byteLength
    ? bytes
    : bytes.subarray(0, byteLength);
}

/**
 * One-shot offscreen capture of a Model GLB.
 * Transparent clear so Content Browser `--card` tiles show through.
 * Callers should pass `resolveMaterial: () => null` so construction materials
 * stay — compiling slot NodeMaterials on this throwaway Scene can lose the
 * shared Engine context.
 */
export async function captureModelThumbnailPng(
  engine: AbstractEngine,
  bytes: Uint8Array,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string, scene: Scene) => Material | null,
  maxEdge: number = DEFAULT_THUMBNAIL_MAX_EDGE,
  options: ModelThumbnailOptions = {},
): Promise<Uint8Array | null> {
  if (options.signal?.aborted) return null;
  const size = Number.isFinite(maxEdge) ? Math.max(1, Math.min(512, Math.floor(maxEdge))) : DEFAULT_THUMBNAIL_MAX_EDGE;
  // Both decodes, their overlap, readback and cleanup share one reservation.
  // This construction-GLB path makes no nested scheduler requests. Prefab
  // captures instead admit their individual scene-owned model loads.
  const sourceClipBytes = options.clipName === undefined ? 0 : options.sourceClipBytes?.byteLength ?? 0;
  try {
    return await nativePreparationForEngine(engine).schedule({
      label: "Model Thumbnail", priority: "background", signal: options.signal,
      temporaryBytes: Math.max(1024, (bytes.byteLength + sourceClipBytes) * 4 + size * size * 16),
    }, () => captureAdmittedModelThumbnail(engine, bytes, slots, resolveMaterial, size, options));
  } catch {
    return null;
  }
}

async function captureAdmittedModelThumbnail(
  engine: AbstractEngine,
  bytes: Uint8Array,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string, scene: Scene) => Material | null,
  size: number,
  options: ModelThumbnailOptions,
): Promise<Uint8Array | null> {
  const host = createModelPreviewScene(engine, { transparent: true });
  let loaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
  let sourceHost: MaterialPreviewScene | null = null;
  let sourceLoaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
  let retargeted: AnimationGroup | null = null;
  let rtt: RenderTargetTexture | null = null;
  try {
    loaded = await loadModelPreviewSource(host, bytes, options.importScale);
    if (!loaded || options.signal?.aborted) return null;
    for (const group of loaded.animationGroups) group.stop();
    if (options.clipName !== undefined) {
      let group: AnimationGroup | null = null;
      if (options.sourceClipBytes?.byteLength) {
        sourceHost = createModelPreviewScene(engine);
        sourceLoaded = await loadModelPreviewSource(
          sourceHost,
          options.sourceClipBytes,
        );
        if (options.signal?.aborted) return null;
        const sourceGroup = sourceLoaded?.animationGroups.find(
          (entry) => entry.name === options.clipName,
        );
        if (sourceGroup) {
          retargeted = retargetAnimationGroupWithMeshProxy(
            sourceGroup,
            previewRigRoot(host),
          );
          group = retargeted;
        }
      } else {
        group =
          loaded.animationGroups.find(
            (entry) => entry.name === options.clipName,
          ) ?? null;
      }
      // A missing clip must not be cached as an unrelated rest-pose thumbnail.
      if (!group) return null;
      group.start(false);
      group.pause();
      group.goToFrame(group.from);
      aimPreviewCameraAtMesh(host.camera, host.mesh);
    }
    applyModelMaterialSlots(host.mesh, slots, (guid) =>
      resolveMaterial(guid, host.scene),
    );
    rtt = createPreviewRenderTarget("modelThumbnail", { width: size, height: size }, host.scene);
    host.camera.outputRenderTarget = rtt;
    // A one-shot render must await imported PBR materials and textures.
    if (!(await waitForPreviewMeshesReady(host.mesh)) || options.signal?.aborted) return null;
    if (!(await renderPreviewFrame(host, () => !options.signal?.aborted))) return null;
    const buffer = await rtt.readPixels();
    if (!buffer || options.signal?.aborted) return null;
    const pixels = rgbaBytesFromReadback(buffer, size * size * 4);
    if (!pixels) return null;
    return encodeRgbaPng(size, size, new Uint8Array(flipReadPixelsRgba(pixels, size, size)));
  } catch {
    return null;
  } finally {
    host.camera.outputRenderTarget = null;
    rtt?.dispose();
    retargeted?.dispose();
    sourceLoaded?.dispose();
    sourceHost?.dispose();
    loaded?.dispose();
    await host.whenReleased().catch(() => {});
  }
}
