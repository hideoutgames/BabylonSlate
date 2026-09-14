import { DrawWrapper, type Effect, type IParticleSystem, type NodeMaterial, type Observer } from "@babylonjs/core";

type NativeParticleBinder = (
  system: IParticleSystem, blend: number,
  onCompiled?: (effect: Effect) => void, onError?: (effect: Effect, errors: string) => void,
  effect?: Effect, defines?: unknown, joined?: string,
) => void;
type ParticleMaterialInternals = { _createEffectForParticles: NativeParticleBinder };
type Binding = { effect: Effect; observer: Observer<Effect>; wrapper: DrawWrapper };
const adapted = new WeakSet<NodeMaterial>();

/**
 * Babylon 9.20's recursive particle binder passes its original empty defines
 * string to a replacement observer. A cached Effect can then append observers
 * indefinitely during the same notification. Keep the current defines and one
 * owned observer per system/blend, without changing Engine or prototype state.
 */
export function prepareNodeMaterialParticleBindings(material: NodeMaterial): void {
  if (adapted.has(material)) return;
  const native = material as unknown as ParticleMaterialInternals;
  const original = native._createEffectForParticles;
  if (typeof original !== "function" || original.length !== 6) {
    throw new Error("Unsupported Babylon particle material binding layout.");
  }
  const priorDescriptor = Object.getOwnPropertyDescriptor(material, "_createEffectForParticles");
  const systems = new Map<IParticleSystem, {
    bindings: Map<number, Binding>;
    disposeObserver: Observer<IParticleSystem> | null;
  }>();
  const releaseSystem = (system: IParticleSystem) => {
    const owned = systems.get(system);
    if (!owned) return;
    systems.delete(system);
    for (const { effect, observer } of owned.bindings.values()) effect.onBindObservable.remove(observer);
    system.onDisposeObservable.remove(owned.disposeObserver);
  };
  const bind: NativeParticleBinder = function(system, blend, onCompiled, onError, effect, defines, joined) {
    let owned = systems.get(system);
    if (!owned) {
      owned = { bindings: new Map(), disposeObserver: system.onDisposeObservable.addOnce(() => releaseSystem(system)) };
      systems.set(system, owned);
    }
    const previous = owned.bindings.get(blend);
    if (previous) {
      previous.effect.onBindObservable.remove(previous.observer);
      owned.bindings.delete(blend);
    }
    if (effect) {
      const current: string[] = [];
      system.fillDefines(current, blend, false);
      joined = current.join("\n");
    }
    original.call(material, system, blend, onCompiled, onError, effect, defines, joined);
    // The pinned native method's final operation adds its one bind observer.
    // Preserve other systems' observers when they share this cached Effect.
    const currentEffect = system.getCustomEffect(blend);
    const observer = currentEffect?.onBindObservable.observers.at(-1);
    const wrapper = (system as unknown as { _customWrappers?: Record<number, DrawWrapper> })._customWrappers?.[blend];
    if (!currentEffect || !observer || observer === previous?.observer || !(wrapper instanceof DrawWrapper) || wrapper.effect !== currentEffect) {
      throw new Error("Babylon did not install the expected particle binding observer.");
    }
    owned.bindings.set(blend, { effect: currentEffect, observer, wrapper });
    // Native setCustomEffect allocates a new wrapper without releasing the old
    // one. Its public deferred disposal preserves the currently executing draw.
    if (previous && previous.wrapper !== wrapper) previous.wrapper.dispose();
  };
  native._createEffectForParticles = bind;
  adapted.add(material);
  material.onDisposeObservable.addOnce(() => {
    for (const system of systems.keys()) releaseSystem(system);
    if (native._createEffectForParticles === bind) {
      if (priorDescriptor) Object.defineProperty(material, "_createEffectForParticles", priorDescriptor);
      else Reflect.deleteProperty(material, "_createEffectForParticles");
    }
    adapted.delete(material);
  });
}
