import type { AbstractEngine, AbstractMesh, Effect } from "@babylonjs/core";
import { SCENE_DRIVER_COMPILE_TIMEOUT_MS } from "./stall-deadline";

/** Babylon exposes no enumeration of the Engine's cached effects. */
type EngineEffects = { _compiledEffects?: Readonly<Record<string, Effect>> };

/**
 * Keys of the effects a parallel-compile driver is still building. With
 * KHR_parallel_shader_compile the driver reports completion only, never
 * progress. Without it a compile blocks inside the call, so nothing is pending.
 */
export function pendingDriverCompiles(engine: AbstractEngine): string[] {
  if (!engine.getCaps().parallelShaderCompile) return [];
  const pending: string[] = [];
  for (const [key, effect] of Object.entries((engine as unknown as EngineEffects)._compiledEffects ?? {}))
    if (!effect.isReady() && !effect.getCompilationError()) pending.push(key);
  return pending;
}

/**
 * Compiles that readiness probes keep pending on the Engine by requesting
 * variants beyond the ones they wait for (`requestCompilesAhead`): enough to
 * overlap slow links (a cold Water shader takes seconds), few enough not to
 * queue a whole scene's variants in front of the one a probe needs next.
 */
export const COMPILE_AHEAD_LIMIT = 4;

/**
 * How many more compiles a readiness probe may start ahead of the variant it
 * waits for: none without parallel compile, where a request links inside the
 * call, and otherwise what the Engine's pending compiles leave of the limit.
 */
export function compileAheadBudget(engine: AbstractEngine): number {
  if (!engine.getCaps().parallelShaderCompile) return 0;
  return Math.max(0, COMPILE_AHEAD_LIMIT - pendingDriverCompiles(engine).length);
}

/**
 * Babylon's ObjectRenderer readiness scan stops at the first unready mesh, so
 * a pass's variants would link one at a time, each after the one before. While
 * the compile-ahead budget lasts, probe what the scan leaves behind its `head`
 * as well: `headRest`, for variants of the head its probe skipped, then the
 * meshes after it in the scan's `meshes`, with the scan's own filter and
 * `probe`. Each probed mesh joins `requested` and is not probed ahead again;
 * the owner clears it once its pass is ready. The results are discarded: the
 * scan alone decides readiness.
 */
export function requestCompilesAhead(
  engine: AbstractEngine,
  meshes: readonly AbstractMesh[],
  head: AbstractMesh,
  requested: Set<AbstractMesh>,
  probe: (mesh: AbstractMesh) => boolean,
  headRest?: (head: AbstractMesh) => boolean,
): void {
  let budget = compileAheadBudget(engine);
  if (budget <= 0) return;
  if (headRest && !requested.has(head)) {
    requested.add(head);
    if (!headRest(head)) budget = compileAheadBudget(engine);
  }
  for (let index = meshes.indexOf(head) + 1; budget > 0 && index < meshes.length; index += 1) {
    const mesh = meshes[index]!;
    if (requested.has(mesh) || !mesh.isEnabled() || mesh.isBlocked || !mesh.isVisible || !mesh.subMeshes) continue;
    requested.add(mesh);
    // A ready mesh started nothing; an unready one started any number of compiles, or none (a pending texture).
    if (!probe(mesh)) budget = compileAheadBudget(engine);
  }
}

/**
 * Decides whether an expired loading budget should be renewed because the
 * driver is still compiling. A compile cascade, such as a Water shader and then
 * its other pass variants, changes the pending set each time one finishes and
 * keeps renewing. The same set pending for `SCENE_DRIVER_COMPILE_TIMEOUT_MS`
 * is a hung compile: the budget is not renewed.
 */
export class DriverCompileWatch {
  private signature = "";
  private since = 0;

  private readonly engine: AbstractEngine;

  constructor(engine: AbstractEngine) {
    this.engine = engine;
  }

  /** Call when a budget expires; true grants another full budget. */
  renew(now = performance.now()): boolean {
    const pending = pendingDriverCompiles(this.engine);
    if (pending.length === 0) {
      this.signature = "";
      return false;
    }
    const signature = pending.sort().join("\n");
    if (signature !== this.signature) {
      this.signature = signature;
      this.since = now;
    }
    return now - this.since < SCENE_DRIVER_COMPILE_TIMEOUT_MS;
  }
}
