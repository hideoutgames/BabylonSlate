import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { drawingMesh } from "./instance-source";

/**
 * The meshes a view's readiness probe asks, while it runs for changes that can have touched only them (a spawned mesh,
 * a mesh that came to cast or receive shadows): every other mesh's variants are as the last passing probe found them,
 * so each per-mesh check answers "ready" for it without building a variant. Everything a probe checks that is not per
 * mesh (textures, cameras, particle systems, layers, readiness checks, each pass's own programs) still runs whole. A
 * leaf module: the probe's per-mesh checks read it without importing the view.
 */
let scope: ReadonlySet<AbstractMesh> | undefined;

/** Render targets a whole probe found ready: a scoped probe asks such a target for the scope's meshes only. */
const probedWhole = new WeakSet<RenderTargetTexture>();

/** The list of a target a scope without meshes asks. */
const NO_MESHES: AbstractMesh[] = [];
const noMeshes = (): AbstractMesh[] => {
  NO_MESHES.length = 0;
  return NO_MESHES;
};

/** Whether scoped probes are followed by a whole one that must agree (`verifyScopedReadinessProbes`). */
let verifies = false;

/** Runs `probe` asking only `meshes`. */
export function withReadinessProbeScope<T>(meshes: ReadonlySet<AbstractMesh>, probe: () => T): T {
  const previous = scope;
  scope = meshes;
  try {
    return probe();
  } finally {
    scope = previous;
  }
}

/**
 * Whether a scoped probe is running that leaves `mesh` out: its variants need no check. An instance is asked when its
 * source is: a pass that lists only the instances probes the source's batch through them.
 */
export function outsideReadinessProbeScope(mesh: AbstractMesh): boolean {
  return scope !== undefined && !scope.has(mesh) && !scope.has(drawingMesh(mesh));
}

/**
 * `target.isReadyForRendering()` for a readiness probe. Inside a scoped probe a target asks only the scope's meshes of
 * its list, unless no whole probe has found it ready yet (a mirror or shadow map made since): that one asks them all.
 */
export function isRenderTargetProbeReady(target: RenderTargetTexture): boolean {
  const meshes = scope;
  if (!meshes || !probedWhole.has(target)) {
    scope = undefined;
    try {
      const ready = target.isReadyForRendering();
      if (ready) probedWhole.add(target);
      return ready;
    } finally {
      scope = meshes;
    }
  }
  const whole = target.customIsReadyFunction;
  const list = target.getCustomRenderList;
  // Babylon asks `mesh.isReady(true)` of a target without a check of its own.
  target.customIsReadyFunction = (mesh, refreshRate, preWarm) =>
    outsideReadinessProbeScope(mesh) || (whole ? whole(mesh, refreshRate, preWarm) : mesh.isReady(true));
  // A scope without meshes (a particle system bound or cancelled) asks none of the target's list, so the list is not
  // built: a shadow map's culls its casters for every layer. What the target checks besides its meshes still runs.
  if (list && meshes.size === 0) target.getCustomRenderList = noMeshes;
  try {
    return target.isReadyForRendering();
  } finally {
    target.customIsReadyFunction = whole;
    if (list && meshes.size === 0) target.getCustomRenderList = list;
  }
}

/**
 * Debugging aid: each scoped probe that passes is followed by a whole probe, which must pass too and request no Effect
 * the scoped one left out. A view counts the disagreements (`RenderDiagnostics.rendererWork.scopedReadinessMismatches`).
 */
export function verifyScopedReadinessProbes(enabled: boolean): void {
  verifies = enabled;
}

export function verifiesScopedReadinessProbes(): boolean {
  return verifies;
}
