import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { watchEngineEffects } from "./effect-requests";

/** Longest a bridge keeps Effects for a view that never presents (a load that failed or was abandoned). */
export const EFFECT_BRIDGE_MS = 120_000;

/**
 * Most Effects an Engine keeps for its next Play (`keepPlayEffects`), least recently used first out: about two
 * Feature Test scenes' Play programs (a large level links about 100, a light one about 50). An Effect holds its
 * program and, on WebGPU, its pipelines, never a texture or render target, so the bound is a count of programs.
 */
export const PLAY_EFFECT_KEEP_BUDGET = 256;

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

/**
 * The Effects an Engine keeps for Play, in use order (the most recently used last), with one reference each, and
 * the Engine observers that end the keep, attached only while it holds any.
 */
type Keep = {
  engine: AbstractEngine;
  effects: Set<Effect>;
  budget: number;
  observers: { disposed: Observer<AbstractEngine>; lost: Observer<AbstractEngine> } | null;
};
const keeps = new WeakMap<AbstractEngine, Keep>();

const failed = (effect: Effect) => Boolean(effect.getCompilationError()) && effect.allFallbacksProcessed();

function keepFor(engine: AbstractEngine): Keep {
  const existing = keeps.get(engine);
  if (existing) return existing;
  const keep: Keep = { engine, effects: new Set(), budget: PLAY_EFFECT_KEEP_BUDGET, observers: null };
  keeps.set(engine, keep);
  return keep;
}

/** Releases the keep's reference; `immediate` with the Engine or its context gone, when no compile will settle. */
function drop(keep: Keep, effect: Effect, immediate = false): void {
  if (!keep.effects.delete(effect)) return;
  // An Effect its owner disposed for good (`dispose(true)`) holds no reference of ours any more.
  if (!effect.isDisposed) {
    if (immediate || effect.isReady() || failed(effect)) effect.dispose();
    else {
      // A parallel-compile driver's program is polled after its last release deletes it
      // (`owned-effect-retirement.ts`): let a compiling one go once Babylon has settled it.
      const settled = () => queueMicrotask(() => effect.dispose());
      effect.onCompileObservable.addOnce(settled);
      effect.onErrorObservable.add(() => {
        if (effect.allFallbacksProcessed()) settled();
      });
    }
  }
  if (keep.effects.size > 0 || !keep.observers) return;
  keep.engine.onDisposeObservable.remove(keep.observers.disposed);
  keep.engine.onContextLostObservable.remove(keep.observers.lost);
  keep.observers = null;
}

/** Retains `effect`, or marks it the most recently used; true when the keep took a new reference. */
function take(keep: Keep, effect: Effect): boolean {
  if (!(effect instanceof Effect) || effect.isDisposed || failed(effect)) return false;
  if (keep.effects.delete(effect)) {
    keep.effects.add(effect);
    return false;
  }
  effect._refCount += 1;
  keep.effects.add(effect);
  const { engine } = keep;
  keep.observers ??= {
    disposed: engine.onDisposeObservable.addOnce(() => releaseKept(keep, true)),
    // A WebGL2 restore relinks every Effect left in the cache: let the kept ones go with the lost context.
    lost: engine.onContextLostObservable.add(() => releaseKept(keep, true)),
  };
  // A program that cannot link is not kept: a later requester would get the failed Effect from the cache without
  // its error. Released after Babylon's error handling returns, as the owner's own release is.
  if (!effect.isReady()) {
    effect.onErrorObservable.add(() => {
      if (effect.allFallbacksProcessed()) queueMicrotask(() => drop(keep, effect));
    });
  }
  for (const oldest of keep.effects) {
    if (keep.effects.size <= keep.budget) break;
    drop(keep, oldest);
  }
  return true;
}

/**
 * Keeps every Effect `engine` returns from now until the returned stop (a Play view's life), and past it: Play's
 * programs then survive Stop and the editor's reload, so the next Play finds those it draws again in the Engine's
 * Effect cache, and a load that releases a program and asks for it again (a graph rebuilt during the load, an
 * environment filter run twice) links it once. One reference each, at most `PLAY_EFFECT_KEEP_BUDGET` Effects
 * (`budget`), the least recently returned released first; a program that fails to link is never kept. The keep goes
 * with the Engine and with a lost context. Stopping clears a settled Effect's compile callbacks, which belong to
 * whoever first created it, so a kept Effect holds no closed Play's Scene. Stopping with `discard` (a view whose
 * construction failed) instead releases the Effects this call took, leaving the keep as it found it.
 */
export function keepPlayEffects(engine: AbstractEngine, budget = PLAY_EFFECT_KEEP_BUDGET): (discard?: boolean) => void {
  if (engine.isDisposed) return () => {};
  const keep = keepFor(engine);
  keep.budget = budget;
  const taken = new Set<Effect>();
  const stopWatching = watchEngineEffects(engine, (effect) => {
    if (take(keep, effect)) taken.add(effect);
  });
  let stopped = false;
  return (discard = false) => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    if (discard) {
      for (const effect of taken) drop(keep, effect);
      return;
    }
    for (const effect of keep.effects) {
      if (effect.isReady()) forgetCreator(effect);
      // Babylon calls `onCompiled` before it notifies the observable.
      else if (!failed(effect)) effect.onCompileObservable.addOnce(() => forgetCreator(effect));
    }
  };
}

function forgetCreator(effect: Effect): void {
  effect.onCompiled = null;
  effect.onError = null;
}

/** Ends `engine`'s keep: Effects nothing else holds are released. */
export function releaseKeptEffects(engine: AbstractEngine): void {
  const keep = keeps.get(engine);
  if (keep) releaseKept(keep);
}

function releaseKept(keep: Keep, immediate = false): void {
  for (const effect of [...keep.effects]) drop(keep, effect, immediate);
}

/** How many Effects `engine` keeps for Play. */
export function keptEffectCount(engine: AbstractEngine): number {
  return keeps.get(engine)?.effects.size ?? 0;
}
