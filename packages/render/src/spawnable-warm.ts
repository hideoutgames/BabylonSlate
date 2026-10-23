import { Mesh, MeshBuilder, type AbstractMesh, type AssetContainer, type Material, type Scene } from "@babylonjs/core";
import { prewarmMeshMaterials } from "./scene-perf";

/**
 * Compiles what Play may spawn, before it does, against the Scene's current lighting: each Material on a staged box
 * (the attributes of a primitive: positions, normals, UVs), and each model's meshes as staged instances of its
 * container. Staged meshes are invisible, unpickable and gone afterwards. The Effects stay in the Engine's cache:
 * Babylon 9.29's `forceCompilation` compiles on a temporary submesh it never disposes, which keeps its reference, so
 * a later mesh with the same variant finds its Effect ready. A cache pre-fill, not a guarantee: a variant also depends
 * on the spawned mesh's own attributes (skinning, morph targets, instances) and the lights that reach it, and what it
 * misses is hidden per mesh until it compiles (`isRevealPending`).
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
  } finally {
    for (const dispose of disposals.splice(0)) dispose();
  }
}
