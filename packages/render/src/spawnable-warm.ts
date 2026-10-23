import { Mesh, MeshBuilder, type AbstractMesh, type AssetContainer, type Material, type Scene } from "@babylonjs/core";
import { prewarmMeshMaterials } from "./scene-perf";
import { hideForPipelineWarmup } from "./reveal-pending";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { pipelinesWarmed } from "./variant-pipeline-warmup";
import { pipelinesDeferred } from "./webgpu-pipeline-deferral";

/** Where pipelines are deferred, staged meshes whose pipelines are not warm yet go after this long all the same. */
export const SPAWNABLE_PIPELINE_WARM_MS = 10_000;

/**
 * Compiles what Play may spawn, before it does, against the Scene's current lighting: each Material on a staged box
 * (the attributes of a primitive: positions, normals, UVs), and each model's meshes as staged instances of its
 * container. Staged meshes are invisible, unpickable and gone afterwards. The Effects stay in the Engine's cache:
 * Babylon 9.29's `forceCompilation` compiles on a temporary submesh it never disposes, which keeps its reference, so
 * a later mesh with the same variant finds its Effect ready. A cache pre-fill, not a guarantee: a variant also depends
 * on the spawned mesh's own attributes (skinning, morph targets, instances) and the lights that reach it, and what it
 * misses is hidden per mesh until it compiles (`isRevealPending`).
 *
 * Where pipelines are deferred (WebGPU) a variant also needs its render pipeline for the pass it draws in, which only
 * a draw in that pass creates. The staged meshes then stay, hidden from every pass (`hideForPipelineWarmup`), until
 * the world view's warm draws have created their pipelines (`variant-pipeline-warmup.ts`), and go afterwards, or after
 * `SPAWNABLE_PIPELINE_WARM_MS`.
 */
export async function warmSpawnables(
  scene: Scene,
  sources: { materials: Iterable<Material>; containers: Iterable<AssetContainer> },
  assertCurrent?: () => void,
): Promise<void> {
  const staged: AbstractMesh[] = [];
  const disposals: (() => void)[] = [];
  const stage = (mesh: AbstractMesh) => {
    mesh.isVisible = false;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    staged.push(mesh);
  };
  try {
    for (const material of sources.materials) {
      const proxy = MeshBuilder.CreateBox(`spawnable-warm:${material.name}`, { size: 1 }, scene);
      proxy.material = material;
      stage(proxy);
      disposals.push(() => proxy.dispose(false, false));
    }
    for (const container of sources.containers) {
      const instance = container.instantiateModelsToScene((name) => `spawnable-warm:${name}`, false, { doNotInstantiate: true });
      for (const root of instance.rootNodes)
        for (const mesh of root.getChildMeshes(false)) if (mesh instanceof Mesh) stage(mesh);
      disposals.push(() => instance.dispose());
    }
    await prewarmMeshMaterials(scene, staged, assertCurrent);
    if (pipelinesDeferred(scene.getEngine())) keepForPipelineWarmup(scene, staged, disposals.splice(0));
  } finally {
    for (const dispose of disposals.splice(0)) dispose();
  }
}

/** Leaves the staged meshes to the view's warm draws, and disposes them once every one's pipelines are warm. */
function keepForPipelineWarmup(scene: Scene, staged: readonly AbstractMesh[], disposals: (() => void)[]): void {
  for (const mesh of staged) {
    // Babylon draws only an enabled, visible mesh; hidden, no pass shows it.
    hideForPipelineWarmup(mesh);
    mesh.isVisible = true;
  }
  const engine = scene.getEngine();
  const since = performance.now();
  const release = () => {
    engine.onEndFrameObservable.remove(watch);
    scene.onDisposeObservable.remove(disposed);
    for (const dispose of disposals.splice(0)) dispose();
  };
  const watch = engine.onEndFrameObservable.add(() => {
    if (staged.every((mesh) => mesh.isDisposed() || pipelinesWarmed(mesh)) || performance.now() - since >= SPAWNABLE_PIPELINE_WARM_MS)
      release();
    // A settled view probes no more: ask it to, so its next steady frame warms them.
    else markSceneReadinessDirty(scene);
  });
  const disposed = scene.onDisposeObservable.addOnce(release);
}
