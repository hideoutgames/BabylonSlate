import type { AbstractMesh } from "@babylonjs/core";
import { RENDERING_GROUP } from "./sorting";

/** Keep a Play debug mesh out of picking, shadows, fog and Play wireframe/bounds. */
export function markPlayDebugOverlay(mesh: AbstractMesh): void {
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  mesh.metadata = { ...(mesh.metadata ?? {}), playDebugOverlay: true };
}
