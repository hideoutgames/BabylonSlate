import type { AbstractMesh, Scene } from "@babylonjs/core";
import { Constants } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";

/** Mesh hit by a GPU pick; `null` is background, `undefined` means use CPU picking. */
export type GpuPickResult = AbstractMesh | null | undefined;

const READY_TIMEOUT_MS = 1000;
const READY_POLL_MS = 16;

/** Same eligibility as Babylon's default `scene.pick` predicate. */
export function gpuPickableMeshes(scene: Scene): AbstractMesh[] {
  return scene.meshes.filter(
    (mesh) => mesh.isPickable && mesh.isVisible && mesh.isEnabled() && mesh.getTotalVertices() > 0,
  );
}

/** Decode the RGB 24-bit id written by Babylon's `encodeObjectId`. */
export function decodeObjectId(pixel: ArrayLike<number>): number {
  return ((pixel[0] ?? 0) << 16) | ((pixel[1] ?? 0) << 8) | (pixel[2] ?? 0);
}

/**
 * Read-back row for a top-down pick pixel. WebGL reads bottom-up, WebGPU top-down.
 */
export function objectIdReadRow(pixelY: number, height: number, webgpu: boolean): number {
  return webgpu ? pixelY : height - pixelY - 1;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pick through each mesh's own material in a one-shot geometry pass writing
 * Babylon's object-ID texture. Vertex deformation (skinning, morphs, lattice,
 * water, node-material offsets) therefore matches what is drawn, unlike the
 * CPU ray against bind-pose geometry. Coordinates are `scene.pick` pixels.
 */
export async function gpuPickMesh(scene: Scene, x: number, y: number): Promise<GpuPickResult> {
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  if (!camera || typeof engine._readTexturePixels !== "function") return undefined;
  const viewport = camera.viewport;
  if (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1) return undefined;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const scale = engine.getHardwareScalingLevel() || 1;
  const px = Math.floor(x / scale);
  const py = Math.floor(y / scale);
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  const meshes = gpuPickableMeshes(scene);
  if (meshes.length === 0) return null;
  if (meshes.length >= 0xffffff) return undefined;
  const ids = new Map<AbstractMesh, number>(meshes.map((mesh, index) => [mesh, index + 1]));

  const graph = new FrameGraph(scene);
  scene.removeFrameGraph(graph);
  try {
    const depth = graph.textureManager.createRenderTargetTexture("GPU Pick Depth", {
      size: { width, height },
      sizeIsPercentage: false,
      options: {
        createMipMaps: false,
        samples: 1,
        types: [Constants.TEXTURETYPE_FLOAT],
        formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
        useSRGBBuffers: [false],
      },
    });
    const clear = new FrameGraphClearTextureTask("GPU Pick Clear", graph);
    clear.depthTexture = depth;
    clear.clearColor = false;
    clear.clearDepth = true;
    clear.clearStencil = false;
    graph.addTask(clear);
    const geometry = new LogicalGeometryTask("GPU Pick Object IDs", graph, scene, { doNotChangeAspectRatio: false });
    geometry.camera = camera;
    geometry.objectList = { meshes, particleSystems: [] };
    geometry.depthTexture = clear.outputDepthTexture;
    geometry.size = { width, height };
    geometry.sizeIsPercentage = false;
    geometry.samples = 1;
    geometry.dontRenderWhenMaterialDepthWriteIsDisabled = false;
    // LOD levels report their master so the hit resolves to the authored mesh.
    geometry.objectIdProvider = (mesh) => ids.get(mesh._masterMesh ?? mesh) ?? ids.get(mesh) ?? 0;
    geometry.textureDescriptions.push({
      type: Constants.PREPASS_OBJECT_ID_TEXTURE_TYPE,
      textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      textureFormat: Constants.TEXTUREFORMAT_RGBA,
    });
    graph.addTask(geometry);
    await graph.buildAsync(false);
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (!graph.isReady()) {
      if (performance.now() > deadline) return undefined;
      await wait(READY_POLL_MS);
    }
    graph.execute();
    const texture = graph.textureManager.getTextureFromHandle(geometry.geometryObjectIdTexture);
    if (!texture) return undefined;
    const pixel = new Uint8Array(engine.isWebGPU ? 256 : 4);
    await engine._readTexturePixels(
      texture, 1, 1, -1, 0, pixel, true, true, px, objectIdReadRow(py, height, engine.isWebGPU),
    );
    const id = decodeObjectId(pixel);
    return id === 0 ? null : meshes[id - 1] ?? null;
  } catch {
    return undefined;
  } finally {
    graph.dispose();
  }
}
