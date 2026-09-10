import type { AnimationGroup, Engine, Material, Scene } from "@babylonjs/core";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
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
  type MaterialPreviewScene,
} from "./material-preview";
import { retargetAnimationGroupWithMeshProxy } from "./node-rig";
import { SCENE_SHADER_WARM_TIMEOUT_MS, settleOrTimeout } from "./scene-perf";
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
  engine: Engine,
  bytes: Uint8Array,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string, scene: Scene) => Material | null,
  maxEdge: number = DEFAULT_THUMBNAIL_MAX_EDGE,
  options: {
    importScale?: number;
    clipName?: string;
    sourceClipBytes?: Uint8Array | null;
  } = {},
): Promise<Uint8Array | null> {
  const host = createModelPreviewScene(engine, { transparent: true });
  let loaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
  let sourceHost: MaterialPreviewScene | null = null;
  let sourceLoaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
  let retargeted: AnimationGroup | null = null;
  let rtt: RenderTargetTexture | null = null;
  try {
    loaded = await loadModelPreviewSource(host, bytes, options.importScale);
    if (!loaded) return null;
    for (const group of loaded.animationGroups) group.stop();
    if (options.clipName !== undefined) {
      let group: AnimationGroup | null = null;
      if (options.sourceClipBytes?.byteLength) {
        sourceHost = createModelPreviewScene(engine);
        sourceLoaded = await loadModelPreviewSource(
          sourceHost,
          options.sourceClipBytes,
        );
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
    const size = Math.max(1, Math.floor(maxEdge));
    rtt = new RenderTargetTexture(
      "modelThumbnail",
      { width: size, height: size },
      host.scene,
      false,
    );
    host.camera.outputRenderTarget = rtt;
    // A one-shot render cannot rely on a later gesture/frame to finish shader
    // compilation. Include imported PBR materials and textures in readiness.
    await settleOrTimeout(
      host.scene.whenReadyAsync(),
      SCENE_SHADER_WARM_TIMEOUT_MS,
    );
    if (!host.scene.isReady()) return null;
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
    retargeted?.dispose();
    sourceLoaded?.dispose();
    sourceHost?.dispose();
    loaded?.dispose();
    host.dispose();
  }
}
