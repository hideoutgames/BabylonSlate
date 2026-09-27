import { MultiMaterial, NodeMaterial, type AbstractMesh, type Material, type Scene } from "@babylonjs/core";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";
import { ownedVisualTexturePreparation } from "./mesh-assets";
import { prewarmMeshMaterials, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import type { SnapshotSceneBinding } from "./snapshot-apply";

/** Prepare an additive actor batch; parent and sibling resources are not load dependencies. */
export async function prepareSceneStream(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotIds: readonly number[],
  options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    onProgress?: (progress: number) => void;
    pendingParticles?: (slots: ReadonlySet<number>) => string[];
  },
): Promise<void> {
  const slots = new Set(slotIds);
  const assignments = new Map([...slots].map((slot) => [slot, binding.meshSorting.get(slot)]));
  const check = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
    for (const slot of slots) {
      if (binding.meshSorting.get(slot) !== assignments.get(slot))
        throw new Error("Streamed actor visuals were replaced during loading.");
    }
  };
  check();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
  });
  const wait = <T>(work: Promise<T>) => Promise.race([work, cancelled]);
  try {
    // Model work includes deferred visual replacement and its owned texture leases.
    const loads = [...slots].flatMap((slot) => {
      const load = binding.slotAnimLoads?.get(slot);
      return load ? [load] : [];
    });
    let completed = 0;
    await wait(Promise.all(loads.map(async (load) => {
      await load;
      check();
      options.onProgress?.(0.45 + 0.15 * ++completed / loads.length);
    })));
    check();
    const roots = [...slots].flatMap((slot) => {
      const root = binding.meshes.get(slot);
      return root ? [root] : [];
    });
    await wait(Promise.all(roots.map((root) => ownedVisualTexturePreparation(root))));
    check();
    const meshes = new Set<AbstractMesh>();
    const materials = new Set<Material>();
    const addMaterial = (material: Material) => {
      if (materials.has(material)) return;
      materials.add(material);
      if (material instanceof MultiMaterial)
        for (const child of material.subMaterials) if (child) addMaterial(child);
    };
    for (const root of roots) {
      for (const mesh of [root, ...root.getChildMeshes()]) {
        meshes.add(mesh);
        if (mesh.getTotalVertices() > 0) addMaterial(mesh.material ?? scene.defaultMaterial);
      }
    }
    let previous = "";
    let lastProgress = Date.now();
    for (;;) {
      check();
      for (const mesh of meshes) if (mesh.isDisposed()) throw new Error("Streamed actor was removed during loading.");
      const pending = options.pendingParticles?.(slots) ?? [];
      for (const material of materials) {
        if (material instanceof NodeMaterial && !nodeMaterialTexturesSampleReady(material))
          pending.push(`material ${material.name}`);
        for (const texture of material.getActiveTextures()) {
          if (texture.loadingError) throw new Error(texture.errorObject?.message ?? `Texture ${texture.name} failed to load.`);
          if (!texture.isRenderTarget && !texture.isReady()) pending.push(`texture ${texture.name}`);
        }
      }
      if (!pending.length) break;
      const key = pending.join("\n");
      if (key !== previous) { previous = key; lastProgress = Date.now(); }
      else if (Date.now() - lastProgress >= SCENE_SHADER_WARM_TIMEOUT_MS)
        throw new Error(`Streamed scene resources did not become ready: ${pending.slice(0, 8).join(", ")}.`);
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 16)));
    }
    options.onProgress?.(0.75);
    await wait(prewarmMeshMaterials(scene, meshes, check));
    check();
    options.onProgress?.(0.95);
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}
