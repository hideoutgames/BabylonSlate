import type { AbstractEngine, Effect } from "@babylonjs/core";
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
