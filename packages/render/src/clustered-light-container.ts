import type { MaterialDefines } from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";

/** Native allocation/packing with first-use NodeMaterial define registration. */
export class ManagedClusteredLightContainer extends ClusteredLightContainer {
  override prepareLightSpecificDefines(
    defines: MaterialDefines,
    lightIndex: number,
  ): void {
    const known =
      "CLUSTLIGHT_BATCH" in defines && "CLUSTLIGHT_SLICES" in defines;
    super.prepareLightSpecificDefines(defines, lightIndex);
    // NodeMaterial pre-registers LIGHT0 but omits these numeric cluster keys.
    // Native PrepareDefinesForLight only rebuilds for a previously unseen slot.
    if (!known) defines.rebuild();
  }
}
