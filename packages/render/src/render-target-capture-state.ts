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

/**
 * A Capture Only Actors capture lists its candidates from its actors' meshes, not from every mesh of the Scene
 * (`RenderTargetCaptures`). Every `ACTOR_LIST_FULL_CHECK_INTERVAL`th list of a capture, and every list while
 * `verifyCaptureActorLists` is on, is made by the walk of every mesh instead; a list that differs is counted.
 */
export const ACTOR_LIST_FULL_CHECK_INTERVAL = 120;

/** What the full walks of a Scene's Capture Only Actors lists found (`rendererWork.captureActorLists`). */
export type CaptureActorListDiagnostics = { checks: number; mismatches: number };

const actorLists = new WeakMap<Scene, CaptureActorListDiagnostics>();

/** The Scene's record of Capture Only Actors list checks; null before its first one. */
export function captureActorListDiagnostics(scene: Scene): CaptureActorListDiagnostics | null {
  return actorLists.get(scene) ?? null;
}

/** Counts one full walk of a Capture Only Actors list, and whether the actors' list differed from it. */
export function noteCaptureActorListCheck(scene: Scene, mismatch: boolean): void {
  let record = actorLists.get(scene);
  if (!record) actorLists.set(scene, (record = { checks: 0, mismatches: 0 }));
  record.checks += 1;
  if (mismatch) record.mismatches += 1;
}

let verifyingActorLists = false;

/** Debugging aid: every Capture Only Actors list is also made by the walk of every mesh, which must agree. */
export function verifyCaptureActorLists(enabled: boolean): void {
  verifyingActorLists = enabled;
}

export function verifyingCaptureActorLists(): boolean {
  return verifyingActorLists;
}
