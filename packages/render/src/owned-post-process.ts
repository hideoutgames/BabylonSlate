import type { Camera, Effect } from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";

const guardedEffects = new WeakSet<Effect>();
function guardDisposedEffectPolling(effect: Effect): void {
  if (guardedEffects.has(effect)) return;
  // Babylon 9.20 checks its pipeline before the disposed flag in _checkIsReady.
  const owned = effect as unknown as { _isReadyInternal(): boolean };
  const ready = owned._isReadyInternal;
  owned._isReadyInternal = function (this: Effect) {
    return this.isDisposed ? false : ready.call(this);
  };
  guardedEffects.add(effect);
}

/**
 * Native camera or graph pass with explicit authored shader/effect ownership.
 * Authored factories use blockCompilation:true, then createEffectForPostProcess.
 * Logical detachment is synchronous; whenDisposed reports bounded CPU/native
 * retirement, while whenReleased confirms actual cleanup after any uncertainty.
 */
export class OwnedPostProcess extends PostProcess {
  private disposed = false;
  private released = false;
  private readonly shaderSources = new Map<string, string>();
  private readonly pendingNative = new Set<OwnedEffectRetirement>();
  private readonly pendingCompletions = new Set<Promise<void>>();
  private readonly failures = new Set<unknown>();
  private resolveDisposal!: () => void;
  private rejectDisposal!: (error: unknown) => void;
  private resolveReleased!: () => void;
  private readonly disposal = new Promise<void>((resolve, reject) => {
    this.resolveDisposal = resolve;
    this.rejectDisposal = reject;
  });
  private readonly release = new Promise<void>((resolve) => { this.resolveReleased = resolve; });

  constructor(...args: ConstructorParameters<typeof PostProcess>) {
    super(...args);
    void this.disposal.catch(() => {});
  }

  get drawWrapper() { return this._effectWrapper.drawWrapper; }
  get isReleased(): boolean { return this.released; }
  whenDisposed(): Promise<void> { return this.disposal; }
  whenReleased(): Promise<void> { return this.release; }

  override updateEffect(...args: Parameters<PostProcess["updateEffect"]>): void {
    if (this.disposed) return;
    for (const [name, suffix] of [[args[6], "VertexShader"], [args[7], "PixelShader"]]) {
      // The fallback vertex source is shared Babylon storage, not registered by
      // this NodeMaterial. Only its generated names are ours to remove.
      if (!name || name === "postprocess") continue;
      const key = name + suffix;
      const source = ShaderStore.GetShadersStore(this.shaderLanguage)[key];
      if (typeof source === "string") this.shaderSources?.set(key, source);
    }
    const previous = this.getEffect();
    const references = previous?._refCount;
    try {
      super.updateEffect(...args);
    } finally {
      const current = this.getEffect();
      if (current) guardDisposedEffectPolling(current);
      // EffectWrapper overwrites its DrawWrapper without releasing the prior
      // reference. A cached same-Effect update also acquires another reference.
      if (previous && (previous !== current || previous._refCount > references!))
        this.track(retireOwnedEffect(previous, () => previous.dispose()));
    }
  }

  private track(retirement: OwnedEffectRetirement): void {
    if (!retirement.isReleased()) {
      this.pendingNative.add(retirement);
      void retirement.released.then(() => this.pendingNative.delete(retirement));
    }
    this.pendingCompletions.add(retirement.completion);
    void retirement.completion.then(
      () => { this.pendingCompletions.delete(retirement.completion); },
      (error) => { this.pendingCompletions.delete(retirement.completion); this.failures.add(error); },
    );
  }

  override dispose(camera?: Camera): void {
    if (this.disposed) return;
    this.disposed = true;
    const attachedCamera = camera ?? this.getCamera();
    // Native Engine/Scene disposal drains their arrays with while(first.dispose).
    // A logically retired entry must leave those arrays before it starts waiting.
    attachedCamera?.detachPostProcess(this);
    attachedCamera?.getScene().removePostProcess(this);
    const registered = this.getEngine().postProcesses;
    const index = registered.indexOf(this);
    if (index !== -1) registered.splice(index, 1);
    this.onApplyObservable.clear();
    this.onBeforeRenderObservable.clear();
    this.onAfterRenderObservable.clear();
    this.onActivateObservable.clear();
    this.onSizeChangedObservable.clear();
    this.onEffectCreatedObservable.clear();
    try { this.onDisposeObservable.notifyObservers(); } catch (error) { this.failures.add(error); }
    this.onDisposeObservable.clear();
    this.track(retireOwnedEffect(this.getEffect() ?? null, () => super.dispose(attachedCamera ?? undefined)));
    const finishSources = () => {
      const store = ShaderStore.GetShadersStore(this.shaderLanguage);
      for (const [key, source] of this.shaderSources) if (store[key] === source) delete store[key];
      this.shaderSources.clear();
      this.released = true;
      this.resolveReleased();
    };
    if (this.pendingNative.size === 0) finishSources();
    else void Promise.all([...this.pendingNative].map((entry) => entry.released)).then(finishSources);
    void Promise.allSettled(this.pendingCompletions).then(() => {
      if (this.failures.size) this.rejectDisposal(new AggregateError(this.failures, "Owned post-process cleanup failed"));
      else void this.release.then(this.resolveDisposal);
    });
  }
}
