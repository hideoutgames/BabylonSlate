import type { AbstractMesh } from "@babylonjs/core";
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
 * waits): without KHR_parallel_shader_compile one probe links every effect
 * before it returns, which can take seconds on a slow host. A wait that never
 * succeeds still ends, at most `boundMs` plus that budget after it started.
 */
export async function waitUntilReady(
  probe: () => boolean,
  keepWaiting: () => boolean,
  boundMs: number = SCENE_SHADER_WARM_TIMEOUT_MS,
  budget?: HeldThreadBudget,
): Promise<boolean> {
  const bound = createHeldThreadBound(boundMs, budget);
  while (keepWaiting()) {
    if (probe()) return true;
    if (bound.expired()) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return false;
}

/** One-shot captures need shader/texture readiness without a later interaction. */
export function waitForPreviewMeshesReady(root: AbstractMesh, budget?: HeldThreadBudget): Promise<boolean> {
  return waitUntilReady(() => previewMeshesReady(root), () => !root.isDisposed(), undefined, budget);
}
