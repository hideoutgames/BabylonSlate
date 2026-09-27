import { MultiMaterial, NodeMaterial, type AbstractMesh, type Material, type Scene } from "@babylonjs/core";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";
import { ownedVisualTexturePreparation } from "./mesh-assets";
import { createStallDeadline, prewarmMeshMaterials, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
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
  let active = true;
  const assignments = new Map([...slots].map((slot) => [slot, binding.meshSorting.get(slot)]));
  const check = () => {
    if (!active) throw new Error("Scene streaming preparation has ended.");
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  const checkAssignment = (slot: number) => {
    if (binding.meshSorting.get(slot) !== assignments.get(slot))
      throw new Error("Streamed actor visuals were replaced during loading.");
  };
  const checkAssignments = () => {
    check();
    for (const slot of slots) checkAssignment(slot);
  };
  checkAssignments();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
  });
  const wait = <T>(work: Promise<T>) => Promise.race([work, cancelled]);
  const waitAssets = async (loads: readonly { slot: number; load: Promise<void> | undefined }[], phase: string, progress?: (completed: number) => void) => {
    const deadline = createStallDeadline(() => `Streamed scene ${phase} made no progress for 30 seconds.`, 30_000);
    let completed = 0;
    await deadline.race(wait(Promise.all(loads.map(async ({ slot, load }) => {
      await load;
      check();
      checkAssignment(slot);
      deadline.advance(phase);
      progress?.(++completed);
    })).then(() => {})));
  };
  try {
    // Model work includes deferred visual replacement and its owned texture leases.
    const loads = [...slots].flatMap((slot) => {
      const load = binding.slotAnimLoads?.get(slot);
      return load ? [{ slot, load }] : [];
    });
    await waitAssets(loads, "models", (completed) => options.onProgress?.(0.45 + 0.15 * completed / loads.length));
    checkAssignments();
    const roots = [...slots].flatMap((slot) => {
      const root = binding.meshes.get(slot);
      return root ? [{ slot, root }] : [];
    });
    await waitAssets(roots.map(({ slot, root }) => ({ slot, load: ownedVisualTexturePreparation(root) })), "textures");
    checkAssignments();
    const meshSlots = new Map<AbstractMesh, number>();
    const materials = new Set<Material>();
    const addMaterial = (material: Material) => {
      if (materials.has(material)) return;
      materials.add(material);
      if (material instanceof MultiMaterial)
        for (const child of material.subMaterials) if (child) addMaterial(child);
    };
    for (const { slot, root } of roots) {
      for (const mesh of [root, ...root.getChildMeshes()]) {
        meshSlots.set(mesh, slot);
        if (mesh.getTotalVertices() > 0) addMaterial(mesh.material ?? scene.defaultMaterial);
      }
    }
    let previous = "";
    let lastProgress = Date.now();
    for (;;) {
      checkAssignments();
      for (const mesh of meshSlots.keys()) if (mesh.isDisposed()) throw new Error("Streamed actor was removed during loading.");
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
    await wait(prewarmMeshMaterials(scene, meshSlots.keys(), (mesh) => {
      check();
      if (mesh) checkAssignment(meshSlots.get(mesh)!);
    }));
    checkAssignments();
    options.onProgress?.(0.95);
  } finally {
    active = false;
    options.signal.removeEventListener("abort", abort);
  }
}
