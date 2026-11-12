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

/** The scope while a scoped probe asks a render target a whole probe found ready (`readinessProbeListScope`). */
let listScope: ReadonlySet<AbstractMesh> | undefined;

/**
 * The only meshes the render target being probed is asked now, or undefined when it is asked every mesh it lists (a
 * whole probe, a target no whole probe found ready, a real pass). A target that builds its list per pass (a shadow
 * map culls its casters for every layer) may list just these and the instances they draw: the others answer "ready"
 * without being asked (`outsideReadinessProbeScope`).
 */
export function readinessProbeListScope(): ReadonlySet<AbstractMesh> | undefined {
  return listScope;
}

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
    const outer = listScope;
    scope = listScope = undefined;
    try {
      const ready = target.isReadyForRendering();
      if (ready) probedWhole.add(target);
      return ready;
    } finally {
      scope = meshes;
      listScope = outer;
    }
  }
  const whole = target.customIsReadyFunction;
  // Babylon asks `mesh.isReady(true)` of a target without a check of its own.
  target.customIsReadyFunction = (mesh, refreshRate, preWarm) =>
    outsideReadinessProbeScope(mesh) || (whole ? whole(mesh, refreshRate, preWarm) : mesh.isReady(true));
  const outer = listScope;
  listScope = meshes;
  try {
    return target.isReadyForRendering();
  } finally {
    listScope = outer;
    target.customIsReadyFunction = whole;
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
