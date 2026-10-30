import type { Mesh } from "@babylonjs/core";
import { isInstanceSource } from "./instance-source";

/**
 * The Material variants Babylon draws `mesh` with, so a compile builds exactly those and no others. Babylon 9 draws a
 * mesh with thin instances only instanced (`hasThinInstances` forces hardware instancing); a mesh with instances also
 * draws plain while none of them shows. A source that only draws its instances (`markInstanceSource`) draws instanced
 * only, its instances or none. A leaf module: the warm-up and instance preparation both import it, and neither may
 * import the other.
 */
export function drawnMaterialVariants(mesh: Mesh): { plain: boolean; instanced: boolean } {
  if (isInstanceSource(mesh)) return { plain: false, instanced: true };
  return { plain: !mesh.hasThinInstances, instanced: mesh.hasThinInstances || mesh.instances.length > 0 };
}
