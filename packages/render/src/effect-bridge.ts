import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Effect } from "@babylonjs/core/Materials/effect";

/** Longest a bridge keeps Effects for a view that never presents (a load that failed or was abandoned). */
export const EFFECT_BRIDGE_MS = 120_000;

type Bridge = { effects: Effect[]; timer: ReturnType<typeof setTimeout> };
const bridges = new WeakMap<AbstractEngine, Bridge>();
/** Engines whose disposal ends their bridge. */
const watched = new WeakSet<AbstractEngine>();

/**
 * Keeps every Effect compiled on `engine` until its next world view has presented (`releaseBridgedEffects`), when a
 * view closes on an Engine that outlives it. The editor's scene view closes before Play loads, and Play's before the
 * editor's scene reloads; both draw mostly the same Materials. Babylon releases an Effect, its program and its
 * pipelines with its last draw wrapper, so without the bridge every such load compiles them again; with it the next
 * load's Materials find them in the Engine's Effect cache. One reference each; a later bridge takes over an earlier
 * one, and the bridge ends after `EFFECT_BRIDGE_MS` or with the Engine.
 */
export function bridgeEngineEffects(engine: AbstractEngine): void {
  if (engine.isDisposed) return;
  const compiled = (engine as unknown as { _compiledEffects?: Record<string, unknown> })._compiledEffects ?? {};
  const effects: Effect[] = [];
  for (const effect of Object.values(compiled)) {
    if (!(effect instanceof Effect) || effect.isDisposed) continue;
    effect._refCount += 1;
    effects.push(effect);
  }
  // Retained before the earlier bridge lets go, so an Effect both hold never reaches zero in between.
  const previous = bridges.get(engine);
  if (!watched.has(engine)) {
    watched.add(engine);
    engine.onDisposeObservable.addOnce(() => releaseBridgedEffects(engine));
  }
  bridges.set(engine, { effects, timer: setTimeout(() => releaseBridgedEffects(engine), EFFECT_BRIDGE_MS) });
  if (previous) release(previous);
}

/** Ends `engine`'s bridge: Effects no view draws any more are released. */
export function releaseBridgedEffects(engine: AbstractEngine): void {
  const bridge = bridges.get(engine);
  if (!bridge) return;
  bridges.delete(engine);
  release(bridge);
}

function release(bridge: Bridge): void {
  clearTimeout(bridge.timer);
  for (const effect of bridge.effects) effect.dispose();
  bridge.effects.length = 0;
}
