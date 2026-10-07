import {
  Color4,
  Mesh,
  NodeMaterialModes,
  RenderTargetTexture,
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
import { createMaterialPreviewScene } from "./material-preview";
import type { MeshAssetContext } from "./mesh-assets";
import { applyMaterialToVisualMeshes } from "./visual-meshes";
import { acquireMaterialTexture, bindResourceCacheToHandle, resourceCacheForEngine } from "./resource-cache";
import { SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { encodeRgbaPng } from "./png-encode";

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

/** Bound loading/readback time and let a superseded project retire its capture. */
async function whileCurrent<T>(work: Promise<T>, current: () => boolean, timeout = PREPARATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeout;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        const check = () => {
          if (!current() || Date.now() >= deadline) {
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
 */
export async function captureAssetThumbnailPng(
  engine: AbstractEngine,
  request: AssetThumbnailRequest,
  shouldContinue: () => boolean = () => true,
  maxEdge = DEFAULT_THUMBNAIL_MAX_EDGE,
): Promise<Uint8Array | null> {
  if (!shouldContinue()) return null;
  const host = createMaterialPreviewScene(engine, { mesh: "sphere" });
  const binding = bindResourceCacheToHandle(resourceCacheForEngine(engine));
  const controller = new AbortController();
  const current = () => shouldContinue() && !host.scene.isDisposed;
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
      if (!material) return null;
      // Always a sphere, independent of the Material document's preview choice.
      applyMaterialToVisualMeshes(host.mesh, material);
      meshes = [host.mesh];
    } else {
      host.mesh.isVisible = false;
      host.scene.shadowsEnabled = false;
      sync = new EditorSceneSync(host.scene, undefined, { resolveMaterial, freezeActiveMeshes: false,
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
      }), current);
      await whileCurrent(sync.whenEditorModelsReady(), current);
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
    if (unavailableMaterial || !frameMeshes(host, meshes)) return null;
    if (!(await whileCurrent(Promise.all(preparations), current)).every(Boolean)) return null;
    const deadline = Date.now() + SCENE_SHADER_WARM_TIMEOUT_MS;
    while (!meshes.every((mesh) => mesh.isReady(true))) {
      if (!current() || Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    if (!current()) return null;
    // Scene sync applies the authored background; captures remain transparent.
    host.scene.clearColor = new Color4(0, 0, 0, 0);
    host.scene.activeCamera = host.camera;
    const size = Number.isFinite(maxEdge) ? Math.max(1, Math.min(512, Math.floor(maxEdge))) : DEFAULT_THUMBNAIL_MAX_EDGE;
    target = new RenderTargetTexture("assetThumbnail", { width: size, height: size }, host.scene, false);
    host.camera.outputRenderTarget = target;
    host.scene.render();
    const readback = await whileCurrent(Promise.resolve(target.readPixels()), current);
    if (!readback || !current()) return null;
    const pixels = readback instanceof ArrayBuffer ? new Uint8Array(readback)
      : new Uint8Array(readback.buffer, readback.byteOffset, readback.byteLength);
    if (pixels.byteLength < size * size * 4) return null;
    return encodeRgbaPng(size, size, new Uint8Array(flipReadPixelsRgba(pixels.subarray(0, size * size * 4), size, size)));
  } catch {
    return null;
  } finally {
    controller.abort();
    host.camera.outputRenderTarget = null;
    target?.dispose();
    sync?.dispose();
    library.dispose();
    host.dispose();
    binding.dispose();
  }
}
