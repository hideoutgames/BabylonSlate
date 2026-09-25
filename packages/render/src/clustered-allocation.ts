import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { Light, type AbstractMesh, type Scene } from "@babylonjs/core";
import { beginEngineAllocationCheckpoint } from "./allocation-checkpoint";

/** Synchronous constructor/growth boundary; cleanup releases only new owned resources. */
export function beginClusteredAllocation(
  scene: Scene,
  afterCleanup?: () => void,
): (failure: unknown) => never {
  const lights = new Set(scene.lights);
  const materials = new Set(scene.materials);
  const rollback = beginEngineAllocationCheckpoint(scene);
  const releaseLightsAndMaterials = (attempt: (release: () => void) => void) => {
    for (const light of scene.lights.slice()) {
      if (lights.has(light) || !(light instanceof ClusteredLightContainer))
        continue;
      // Pinned constructor boundary: the proxy has left scene.meshes before its
      // first RTT allocation. The ordinary subclass dispose assumes both target
      // fields exist; a thrown constructor has not necessarily assigned them.
      const proxy = (light as unknown as { _proxyMesh?: AbstractMesh })
        ._proxyMesh;
      if (proxy) attempt(() => proxy.dispose(false, true));
      attempt(() => Light.prototype.dispose.call(light));
    }
    for (const material of scene.materials.slice())
      if (!materials.has(material)) attempt(() => material.dispose());
  };
  return (failure) => {
    const errors: unknown[] = [
      failure,
      ...rollback({ before: releaseLightsAndMaterials }),
    ];
    if (errors.length > 1)
      throw new AggregateError(errors, "Clustered allocation cleanup failed.");
    afterCleanup?.();
    throw failure;
  };
}
