import type { AbstractMesh } from "@babylonjs/core";
import { DriverCompileWatch, renewOnCompileProgress } from "./driver-compile";
import { createHeldThreadBound, SCENE_SHADER_WARM_TIMEOUT_MS, type HeldThreadBudget } from "./stall-deadline";
import { visualMeshes } from "./visual-meshes";

/** Compile only drawn preview parts, excluding hidden placeholders and other Scenes. */
export function previewMeshesReady(root: AbstractMesh): boolean {
  if (root.isDisposed()) return false;
  return visualMeshes(root)
    .filter((mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0)
    .every((mesh) => mesh.isReady(true));
}

/**
 * Poll `probe` every 16 ms while `keepWaiting` holds. False once the wait is
 * abandoned or `boundMs` runs out without the probe succeeding. Time the probe
 * itself holds the thread is not charged against the bound, up to `budget`
 * (a fresh `SCENE_THREAD_HELD_BUDGET_MS` unless a capture shares one across its
 * waits): where links are synchronous one probe links every effect before it
 * returns, which can take seconds on a slow host. With `compiles`, a bound that
 * runs out while shaders keep finishing on its Engine starts again (links
 * shorter than SCENE_THREAD_HELD_MS earn no credit). A wait that never succeeds
 * still ends: once a whole bound passes without progress, at the latest at the
 * watch's ceiling.
 */
export async function waitUntilReady(
  probe: () => boolean,
  keepWaiting: () => boolean,
  boundMs: number = SCENE_SHADER_WARM_TIMEOUT_MS,
  budget?: HeldThreadBudget,
  compiles?: DriverCompileWatch,
): Promise<boolean> {
  const bound = createHeldThreadBound(boundMs, budget, compiles && renewOnCompileProgress(compiles));
  while (keepWaiting()) {
    if (probe()) return true;
    if (bound.expired()) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return false;
}

/**
 * One-shot captures need shader/texture readiness without a later interaction.
 * `current` abandons the wait as soon as its owner stops wanting it.
 */
export function waitForPreviewMeshesReady(
  root: AbstractMesh,
  budget?: HeldThreadBudget,
  compiles: DriverCompileWatch = new DriverCompileWatch(root.getEngine()),
  current: () => boolean = () => true,
): Promise<boolean> {
  return waitUntilReady(() => previewMeshesReady(root), () => !root.isDisposed() && current(), undefined, budget, compiles);
}
