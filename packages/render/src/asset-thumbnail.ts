import {
  Color4,
  Mesh,
  NodeMaterialModes,
  type RenderTargetTexture,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Material,
} from "@babylonjs/core";
import { DEFAULT_THUMBNAIL_MAX_EDGE } from "@babylonslate/assets";
import type { SerializedScene } from "@babylonslate/core";
import type { MaterialDocument, MaterialFunctionDocument } from "@babylonslate/shader-graph";
import { EditorSceneSync } from "./editor-scene-sync";
import { isEditorBillboardMesh } from "./editor-billboard";
import { isEditorCameraModel } from "./editor-camera-model";
import { isEditorVolumeMesh } from "./editor-volume";
import { isColliderVisualMesh } from "./collider-visual";
import { isSkyboxMesh } from "./skybox";
import { hasSurfaceVisual } from "./scene-loader";
import { MaterialLibrary, type MaterialResolveOptions } from "./material-library";
import { createMaterialPreviewScene, createPreviewRenderTarget, renderPreviewFrame } from "./material-preview";
import type { MeshAssetContext } from "./mesh-assets";
import { applyMaterialToVisualMeshes } from "./visual-meshes";
import { acquireMaterialTexture, bindResourceCacheToHandle, resourceCacheForEngine } from "./resource-cache";
import { waitUntilReady } from "./preview-readiness";
import { PreparationTimedOut } from "./scene-render-coordinator";
import { createHeldThreadBound, createHeldThreadBudget, SCENE_CAPTURE_CEILING_MS, type HeldThreadBudget } from "./stall-deadline";
import { DriverCompileWatch, renewOnCompileProgress } from "./driver-compile";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { encodeRgbaPng } from "./png-encode";
import { thumbnailMiss, type ThumbnailCaptureResult } from "./thumbnail-capture";

type ThumbnailAssets = {
  materials: ReadonlyMap<string, MaterialDocument>;
  functions?: Record<string, MaterialFunctionDocument>;
  assets?: MeshAssetContext;
};

export type AssetThumbnailRequest = ThumbnailAssets & (
  | { kind: "Material"; materialGuid: string }
  | { kind: "ActorPrefab"; prefab: SerializedScene }
);

const PREPARATION_TIMEOUT_MS = 30_000;

/**
 * What every wait of one capture shares: its held-thread budget and its compile
 * progress watch, and whether a wait's own bound ran out (`timedOut`).
 */
type CaptureBounds = { budget: HeldThreadBudget; compiles: DriverCompileWatch; timedOut: boolean };

/**
 * Bound loading/readback time and let a superseded project retire its capture.
 * Time the thread was held (a synchronous shader link, a throttled timer) is not
 * charged against the bound, up to the capture's shared budget, and the bound
 * starts again while shaders keep finishing on the Engine, up to the watch's
 * ceiling.
 */
async function whileCurrent<T>(work: Promise<T>, current: () => boolean, bounds: CaptureBounds, timeout = PREPARATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = createHeldThreadBound(timeout, bounds.budget, renewOnCompileProgress(bounds.compiles));
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        const check = () => {
          if (!current()) {
            reject(new Error("Asset thumbnail capture ended."));
            return;
          }
          if (bound.expired()) {
            bounds.timedOut = true;
            reject(new Error("Asset thumbnail capture expired."));
            return;
          }
          timer = setTimeout(check, 16);
        };
        check();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function drawnSurface(mesh: AbstractMesh): boolean {
  return mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 &&
    !mesh.isBlocked && mesh.getTotalVertices() > 0 &&
    !(mesh instanceof Mesh && (isEditorBillboardMesh(mesh) || isColliderVisualMesh(mesh))) &&
    !isEditorCameraModel(mesh) && !isEditorVolumeMesh(mesh) && !isSkyboxMesh(mesh);
}

/** Frame all visual parts together, including offset children and imported bounds. */
function frameMeshes(host: ReturnType<typeof createMaterialPreviewScene>, meshes: AbstractMesh[]): boolean {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    if (mesh.skeleton) {
      mesh.skeleton.prepare(true);
      mesh.refreshBoundingInfo({ applySkeleton: true });
    }
    const box = mesh.getBoundingInfo().boundingBox;
    Vector3.CheckExtends(box.minimumWorld, min, max);
    Vector3.CheckExtends(box.maximumWorld, min, max);
  }
  const diameter = Vector3.Distance(min, max);
  if (!Number.isFinite(diameter) || diameter <= 0) return false;
  host.camera.setTarget(min.add(max).scale(0.5));
  host.camera.lowerRadiusLimit = null;
  host.camera.upperRadiusLimit = null;
  host.camera.radius = diameter * 1.2;
  host.camera.minZ = Math.max(0.0001, diameter / 1000);
  host.camera.maxZ = Math.max(100, diameter * 4);
  return true;
}

/**
 * One shared-engine, one-frame capture. Material graphs use the real compiler;
 * prefabs use the editor's hierarchy/model realization without running scripts.
 * The owner queues calls; no Engine, render loop, or persistent Scene is created.
 * `ceilingMs` ends the capture whatever compiles meanwhile (a retry passes a
 * longer one); a capture that runs out reports `expired`.
 */
export async function captureAssetThumbnailPng(
  engine: AbstractEngine,
  request: AssetThumbnailRequest,
  shouldContinue: () => boolean = () => true,
  maxEdge = DEFAULT_THUMBNAIL_MAX_EDGE,
  ceilingMs = SCENE_CAPTURE_CEILING_MS,
): Promise<ThumbnailCaptureResult> {
  if (!shouldContinue()) return { outcome: "cancelled" };
  // Every wait of this capture credits held time from one budget, so a capture
  // that never becomes ready cannot hold the serialized thumbnail queue for a
  // full budget at each step; one compile watch gives them one ceiling, which
  // also ends the capture's own preparation (`current`).
  const compiles = new DriverCompileWatch(engine, undefined, ceilingMs);
  const bounds: CaptureBounds = { budget: createHeldThreadBudget(), compiles, timedOut: false };
  const { budget } = bounds;
  const host = createMaterialPreviewScene(engine, { mesh: "sphere" });
  const binding = bindResourceCacheToHandle(resourceCacheForEngine(engine));
  const controller = new AbortController();
  const current = () => shouldContinue() && !host.scene.isDisposed && performance.now() < compiles.ceiling;
  /** No image because a wait's bound or the capture's ceiling ran out, rather than for a reason of the asset. */
  const ranOut = () => thumbnailMiss(shouldContinue(), { ceiling: compiles.ceiling, stalled: bounds.timedOut });
  const preparations: Promise<boolean>[] = [];
  const resolved = new Map<string, Material | null>();
  const functions = request.functions ?? {};
  let unavailableMaterial = false;
  const library = new MaterialLibrary({
    functions: () => functions,
    acquireTexture: (guid) => {
      const bytes = request.assets?.textureBytes?.get(guid);
      return bytes ? acquireMaterialTexture(binding.cache, guid, engine, bytes) : null;
    },
    textureIdentity: (guid) => request.assets?.textureBytes?.has(guid) ? guid : undefined,
  });
  const resolveMaterial = (guid: string, options?: MaterialResolveOptions): Material | null => {
    if (options?.instanceKey) {
      const document = request.materials.get(guid);
      const material = document ? library.resolve(host.scene, guid, document, options) : null;
      if (material?.mode === NodeMaterialModes.Material) return material;
      unavailableMaterial = true;
      return null;
    }
    const key = `${guid}:${options?.unlit === true}`;
    if (resolved.has(key)) return resolved.get(key) ?? null;
    const document = request.materials.get(guid);
    const acquired = document ? library.acquire(host.scene, guid, document, options) : null;
    if (!acquired?.ok || acquired.material.mode !== NodeMaterialModes.Material) {
      unavailableMaterial = true;
      resolved.set(key, null);
      return null;
    }
    resolved.set(key, acquired.material);
    preparations.push(acquired.ready.then((diagnostics) => diagnostics.length === 0));
    return acquired.material;
  };
  let sync: EditorSceneSync | undefined;
  let target: RenderTargetTexture | undefined;
  try {
    let meshes: AbstractMesh[];
    if (request.kind === "Material") {
      const material = resolveMaterial(request.materialGuid);
      if (!material) return thumbnailMiss(shouldContinue());
      // Always a sphere, independent of the Material document's preview choice.
      applyMaterialToVisualMeshes(host.mesh, material);
      meshes = [host.mesh];
    } else {
      host.mesh.isVisible = false;
      host.scene.shadowsEnabled = false;
      sync = new EditorSceneSync(host.scene, undefined, { resolveMaterial, preparationPriority: "background",
        releaseMaterialInstance: (key, guid) => library.releaseInstance(key, guid),
        validateMaterialParameter: (guid, name, value) => {
          const document = request.materials.get(guid);
          return !!document && library.acceptsParameter(document, name, value);
        },
      });
      // Simplifying imported models for automatic LOD would repeat expensive
      // work for a single 128px frame; thumbnail Scenes have no distant views.
      const modelPayloads = request.assets?.modelPayloads && new Map(
        [...request.assets.modelPayloads].map(([guid, payload]) => [guid, { ...payload, autoLod: false }]),
      );
      await whileCurrent(sync.applyAsync(request.prefab, {
        signal: controller.signal,
        assets: { ...request.assets, modelPayloads, resourceCache: binding.cache, resolveMaterial },
      }), current, bounds);
      await whileCurrent(sync.whenEditorModelsReady(), current, bounds);
      for (const animation of host.scene.animationGroups) animation.stop();
      meshes = [...new Set(request.prefab.actors.flatMap((actor) => {
        if (!hasSurfaceVisual(actor)) return [];
        // The prefab editor's root marker is chrome, not authored geometry.
        if (actor.components.every((component) => component.classId === "MeshComponent" && component.properties.meshKind === "pivot")) return [];
        return sync!.visualMeshesForActor(actor.id);
      }))].filter(drawnSurface);
      const surfaces = new Set(meshes);
      // outputRenderTarget renders the Scene's active queue; keep helper meshes
      // out without disabling a parent that carries authored child transforms.
      for (const mesh of host.scene.meshes) if (!surfaces.has(mesh)) mesh.isVisible = false;
      if (request.prefab.settings.physicsWorld === "2d") {
        host.camera.alpha = -Math.PI / 2;
        host.camera.beta = Math.PI / 2;
      }
    }
    if (unavailableMaterial || !frameMeshes(host, meshes)) return thumbnailMiss(shouldContinue());
    if (!(await whileCurrent(Promise.all(preparations), current, bounds)).every(Boolean)) return thumbnailMiss(shouldContinue());
    // A wait ends unready when the capture stopped being current (cancelled, past
    // its ceiling, or its Scene was disposed) or its bound ran out. A disposed
    // Scene is no time limit, as in `whileCurrent`.
    if (!(await waitUntilReady(() => meshes.every((mesh) => mesh.isReady(true)), current, undefined, budget, compiles))) {
      bounds.timedOut = !host.scene.isDisposed;
      return ranOut();
    }
    // Scene sync applies the authored background; captures remain transparent.
    host.scene.clearColor = new Color4(0, 0, 0, 0);
    host.scene.activeCamera = host.camera;
    const size = Number.isFinite(maxEdge) ? Math.max(1, Math.min(512, Math.floor(maxEdge))) : DEFAULT_THUMBNAIL_MAX_EDGE;
    target = createPreviewRenderTarget("assetThumbnail", { width: size, height: size }, host.scene);
    host.camera.outputRenderTarget = target;
    if (!(await renderPreviewFrame(host, current, budget, compiles))) {
      bounds.timedOut = !host.scene.isDisposed;
      return ranOut();
    }
    const readback = await whileCurrent(Promise.resolve(target.readPixels()), current, bounds);
    if (!readback || !current()) return ranOut();
    const pixels = readback instanceof ArrayBuffer ? new Uint8Array(readback)
      : new Uint8Array(readback.buffer, readback.byteOffset, readback.byteLength);
    if (pixels.byteLength < size * size * 4) return thumbnailMiss(shouldContinue());
    return { outcome: "captured", png: encodeRgbaPng(size, size, new Uint8Array(flipReadPixelsRgba(pixels.subarray(0, size * size * 4), size, size))) };
  } catch (error) {
    // A wait that reached the ceiling rejects without saying why (ranOut tells it
    // by the clock), unlike the frame graph's own preparation bound.
    if (error instanceof PreparationTimedOut) bounds.timedOut = true;
    return ranOut();
  } finally {
    controller.abort();
    host.camera.outputRenderTarget = null;
    target?.dispose();
    sync?.dispose();
    library.dispose();
    // The Scene still holds cache-bound resources until its renderer releases.
    await host.whenReleased().catch(() => {});
    binding.dispose();
  }
}
