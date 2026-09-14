import { Effect, type AbstractEngine, type Observer } from "@babylonjs/core";

export interface OwnedEffectRetirement {
  /** Bounded cleanup result. Rejection does not establish safe resource release. */
  completion: Promise<void>;
  /** Actual CPU/native-reference release, possibly after a reported deadline. */
  released: Promise<void>;
  isReleased(): boolean;
}

/**
 * Retain one owned DrawWrapper reference while its last WebGL program compiles.
 * Pinned Babylon 9.20: native parallel compilation polls the same program after
 * EffectWrapper.dispose() normally decrements that reference and deletes it.
 * No native refcount, compiler callback, global prototype or frame is replaced.
 */
export function retireOwnedEffect(
  effect: Effect | null,
  disposeResources: () => void,
): OwnedEffectRetirement {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  let resolveReleased!: () => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The owner can retire a pass before its host asks for whenDisposed().
  void completion.catch(() => {});
  const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
  let releasedResources = false;
  let disposedResources = false;
  let attempted = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const engine = effect?.getEngine();
  let compiled: Observer<Effect> | null = null;
  let failed: Observer<Effect> | null = null;
  let destroyed: Observer<AbstractEngine> | null = null;
  let lost: Observer<AbstractEngine> | null = null;
  const detach = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (compiled) effect!.onCompileObservable.remove(compiled);
    if (failed) effect!.onErrorObservable.remove(failed);
    if (destroyed) engine!.onDisposeObservable.remove(destroyed);
    if (lost) engine!.onContextLostObservable.remove(lost);
  };
  const uncertain = (reason: string) => rejectCompletion(new Error(
    `Post-process cleanup is uncertain: ${reason}`,
  ));
  const finish = () => {
    if (attempted) return;
    attempted = true;
    try {
      const references = effect?._refCount;
      disposeResources();
      disposedResources = true;
      // PersistentMode deliberately ignores ordinary effect releases. Preserve
      // that caller policy; it is not evidence that our native reference ended.
      if (effect && !effect.isDisposed && effect._refCount === references) {
        uncertain("the native Effect reference was retained");
        return;
      }
      releasedResources = true;
      detach();
      resolveReleased();
      resolveCompletion();
    } catch (error) {
      rejectCompletion(new Error("Post-process cleanup failed", { cause: error }));
      // Do not retry a partially completed native disposal.
    }
  };
  const afterCompiler = () => {
    if (queued || attempted) return;
    queued = true;
    // onCompile/onError run inside Babylon's pipeline finalizer. Releasing in
    // their callback would delete the program before that native stack returns.
    queueMicrotask(finish);
  };
  const pipeline = effect?.getPipelineContext();
  const pending = effect && !effect.isDisposed && !engine!.isDisposed &&
    !engine!.isWebGPU && effect._refCount === 1 &&
    pipeline?.isAsync && Boolean((pipeline as { program?: unknown }).program) &&
    !effect.isReady() && !(effect.getCompilationError() && effect.allFallbacksProcessed());
  if (engine && !engine.isDisposed) {
    destroyed = engine.onDisposeObservable.addOnce(() => {
      if (!attempted) finish();
      // Engine disposal is the final native owner even if our earlier release
      // failed. Keep the reported failure, while allowing eventual CPU cleanup.
      if (effect?.isDisposed && disposedResources && !releasedResources) {
        releasedResources = true;
        detach();
        resolveReleased();
      }
    });
  }
  if (pending || (effect && Effect.PersistentMode && !effect.isDisposed)) {
    compiled = effect!.onCompileObservable.add(afterCompiler);
    failed = effect!.onErrorObservable.add(() => {
      if (effect!.allFallbacksProcessed()) afterCompiler();
    });
    lost = engine!.onContextLostObservable.add(() => uncertain("the graphics context was lost"));
    timer = setTimeout(() => uncertain("native shader compilation did not settle within 15 seconds"), 15_000);
  } else {
    finish();
  }
  return { completion, released, isReleased: () => releasedResources };
}
