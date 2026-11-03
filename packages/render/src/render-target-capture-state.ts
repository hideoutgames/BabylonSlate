import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Scene } from "@babylonjs/core/scene";
import { isEditorHelperMesh } from "./helper-mesh";

/** Auxiliary camera swaps leave the main view's prepared graph unchanged. */
export const renderTargetCaptureDrawing = new WeakSet<Scene>();

/**
 * Whether a mesh may appear in a Render Target Capture: world geometry only,
 * never lines, editor helpers or Play debug visuals. The editor's capture
 * preview uses the same rule so it shows what the capture lens records.
 */
export function isRenderTargetCaptureCandidate(mesh: AbstractMesh): boolean {
  return !(mesh instanceof LinesMesh) && !isEditorHelperMesh(mesh);
}
