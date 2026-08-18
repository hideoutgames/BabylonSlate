import type { Engine } from "@babylonjs/core";
import {
  createMaterialPreviewScene,
  type MaterialPreviewScene,
} from "./material-preview";

/**
 * Disposable particle Preview Scene on the app-lifetime Engine.
 *
 * Reuses the Material preview host (RTT + 2D blit, never a second Engine).
 * The preview primitive is hidden so only billboard quads are visible.
 */
export function createParticlePreviewScene(
  engine: Engine,
): MaterialPreviewScene {
  const host = createMaterialPreviewScene(engine);
  host.mesh.isVisible = false;
  host.mesh.isPickable = false;
  return host;
}
