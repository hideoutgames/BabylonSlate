import { Mesh, MeshBuilder, type AbstractMesh, type AssetContainer, type Effect, type Material, type Scene } from "@babylonjs/core";
import { recordEffectRequests } from "./effect-requests";
import { prewarmMeshMaterials } from "./scene-perf";

/** Effects a spawnable warm-up compiled, held until the Scene goes, per Scene. */
const retained = new WeakMap<Scene, Set<Effect>>();

/**
 * Compiles what Play may spawn, before it does, against the Scene's current lighting: each Material on a staged box
 * (the attributes of a primitive: positions, normals, UVs), and each model's meshes as staged instances of its
 * container. Staged meshes are invisible, unpickable and gone afterwards; the Effects they compiled are retained for
 * the Scene's life (a later mesh with the same variant finds its Effect ready in the Engine's cache), since Babylon
 * releases an Effect with its last user. A cache pre-fill, not a guarantee: a variant also depends on the spawned
 * mesh's own attributes (skinning, morph targets, instances) and the lights that reach it, and what it misses is
 * hidden per mesh until it compiles (`isRevealPending`).
 */
export async function warmSpawnables(
  scene: Scene,
  sources: { materials: Iterable<Material>; containers: Iterable<AssetContainer> },
  assertCurrent?: () => void,
): Promise<void> {
  const effects = new Set<Effect>();
  const stop = recordEffectRequests(scene.getEngine(), effects);
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
  } finally {
    stop();
    for (const dispose of disposals.splice(0)) dispose();
    let held = retained.get(scene);
    if (!held) {
      held = new Set();
      retained.set(scene, held);
      const owned = held;
      scene.onDisposeObservable.addOnce(() => {
        for (const effect of owned) effect.dispose();
        owned.clear();
      });
    }
    // One reference per Effect, taken as `createEffect` takes one for each user.
    for (const effect of effects) {
      if (held.has(effect) || effect.isDisposed) continue;
      (effect as unknown as { _refCount: number })._refCount++;
      held.add(effect);
    }
  }
}
