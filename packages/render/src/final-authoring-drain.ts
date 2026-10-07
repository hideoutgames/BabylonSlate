import { Mesh, type Scene } from "@babylonjs/core";
import { MaterialLibrary, ownedMaterialPreparation } from "./material-library";
import { componentIdForPlayMesh, wantsOverlayUnlitMaterial, type SnapshotSceneBinding } from "./snapshot-apply";
import { prepareSceneStream } from "./scene-stream-preparation";

/** Explicit Keep-only resource fence. The caller has already processed every
 * command preceding the runtime quiesce acknowledgment. This does not render,
 * tick the world, or substitute a diagnostic snapshot for owner state. */
export async function drainFinalAuthoringResources(scene: Scene, binding: SnapshotSceneBinding, library: MaterialLibrary, options: {
  signal: AbortSignal;
  assertCurrent(): void;
  pendingParticles?: (slots: ReadonlySet<number>) => string[];
}): Promise<void> {
  if (binding.meshes.size > 250_000) throw new Error("The final scene exceeds the render-owner capture limit.");
  options.assertCurrent();
  options.signal.throwIfAborted();
  await prepareSceneStream(scene, binding, [...binding.meshes.keys()], options);
  const prepared = new Set<import("@babylonjs/core").Material>();
  for (const [slot, root] of binding.meshes) {
    options.assertCurrent();
    options.signal.throwIfAborted();
    if (root.isDisposed()) throw new Error(`Actor slot ${slot} has a disposed final visual.`);
    for (const mesh of [root, ...root.getChildMeshes().filter((value): value is Mesh => value instanceof Mesh)]) {
      const componentId = componentIdForPlayMesh(mesh, slot, binding);
      const componentKey = `${slot}|${componentId ?? ""}`;
      const ownAssignment = binding.componentMaterialGuids.has(componentKey);
      const guid = ownAssignment ? binding.componentMaterialGuids.get(componentKey) : binding.materialAssetGuids.get(slot);
      if (!guid) continue;
      const key = binding.materialParameters.has(componentKey) || ownAssignment ? componentKey : `${slot}|`;
      const parameters = binding.materialParameters.get(key);
      const resolveOptions = { unlit: wantsOverlayUnlitMaterial(binding, slot), ...(parameters?.materialAssetGuid === guid ? { instanceKey: key } : {}) };
      const material = library.materialFor(mesh.getScene(), guid, resolveOptions);
      if (!material) throw new Error(`Material ${guid} on actor slot ${slot} has no complete native owner.`);
      if (!prepared.has(material)) {
        prepared.add(material);
        const diagnostics = await ownedMaterialPreparation(material);
        options.assertCurrent();
        options.signal.throwIfAborted();
        if (diagnostics?.length) throw new Error(`Material ${guid}: ${diagnostics.map(entry => entry.message).join("; ")}`);
      }
      // Composed text/tiles own their assignment through the visual preparation
      // above; ordinary Mesh materials must exactly match the admitted owner.
      if (!mesh.metadata?.text2d && !mesh.metadata?.text2dGlyph && !mesh.metadata?.tilemapChunk && mesh.material !== material)
        throw new Error(`Material ${guid} on actor slot ${slot} has not reached its final effective visual.`);
    }
  }
  options.assertCurrent();
  options.signal.throwIfAborted();
}
