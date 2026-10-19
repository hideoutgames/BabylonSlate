import type { AbstractEngine, Effect } from "@babylonjs/core";

type EffectEngine = { createEffect(...args: unknown[]): Effect };

/** Per Engine, the sets the open `collectEffectRequests` calls fill, innermost last. */
const collectors = new WeakMap<AbstractEngine, Set<Effect>[]>();

function install(engine: AbstractEngine): Set<Effect>[] {
  const target = engine as unknown as EffectEngine;
  const create = target.createEffect;
  if (typeof create !== "function") throw new Error("Unsupported Babylon engine layout: createEffect is missing.");
  const open: Set<Effect>[] = [];
  const own = Object.prototype.hasOwnProperty.call(engine, "createEffect");
  target.createEffect = function (this: EffectEngine, ...args: unknown[]) {
    const effect = create.apply(this, args);
    // A cached Effect another owner built first is still this owner's request.
    for (const into of open) into.add(effect);
    return effect;
  };
  engine.onDisposeObservable.addOnce(() => {
    if (own) target.createEffect = create;
    else delete (target as Partial<EffectEngine>).createEffect;
    collectors.delete(engine);
  });
  return open;
}

/**
 * Runs `run`, adding every Effect the Engine's `createEffect` returns meanwhile to `into`. Babylon requests
 * an Effect when a probe first needs a variant and then waits on it, so the set names the Effects one owner's
 * own readiness probes wait for among everything compiling on the shared Engine (previews, thumbnails and
 * Custom GLSL probes included). Only code that runs inside `run` is attributed, never work that awaits.
 */
export function collectEffectRequests<T>(engine: AbstractEngine, into: Set<Effect>, run: () => T): T {
  let open = collectors.get(engine);
  if (!open) {
    open = install(engine);
    collectors.set(engine, open);
  }
  open.push(into);
  try {
    return run();
  } finally {
    open.splice(open.lastIndexOf(into), 1);
  }
}
