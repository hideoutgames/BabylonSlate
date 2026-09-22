import { NodeMaterialModes, type NodeMaterial } from "@babylonjs/core";
import type { MaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import type { ParticleMaterialOwner } from "./particle-service";
import type { ResourceLease } from "./resource-cache";

/** An emitter owns a mutable instance, while MaterialLibrary owns its compiled generation and texture bindings. */
export function acquireParticleMaterial(
  library: MaterialLibrary,
  guid: string,
  document: MaterialDocument,
  owner: ParticleMaterialOwner,
): ResourceLease<NodeMaterial> | null {
  const options = { instanceKey: owner.instanceKey };
  const acquired = library.acquire(owner.scene, guid, document, options);
  if (materialUnavailable(acquired)) return null;
  if (acquired.material.mode !== NodeMaterialModes.Particle) {
    library.release(owner.scene, guid, options);
    return null;
  }
  let released = false;
  const ready = acquired.ready.then((errors) => {
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  });
  void ready.catch(() => {});
  return {
    key: `${owner.instanceKey}:${guid}:${acquired.hash}`,
    resource: acquired.material,
    ready,
    release: () => {
      if (released) return;
      released = true;
      library.release(owner.scene, guid, options);
    },
  };
}
