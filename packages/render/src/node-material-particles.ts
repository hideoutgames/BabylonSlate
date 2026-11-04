import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { DrawWrapper } from "@babylonjs/core/Materials/drawWrapper";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";
import { GPUParticleSystem } from "@babylonjs/core/Particles/gpuParticleSystem";
// Custom effects bypass GPUParticleSystem's default effect initializer, which
// normally imports its WGSL vertex shader before requesting compilation.
import "@babylonjs/core/ShadersWGSL/gpuRenderParticles.vertex";

type NativeParticleBinder = (
  system: IParticleSystem, blend: number,
  onCompiled?: (effect: Effect) => void, onError?: (effect: Effect, errors: string) => void,
  effect?: Effect, defines?: unknown, joined?: string,
) => void;
type ParticleMaterialInternals = { _createEffectForParticles: NativeParticleBinder; _checkInternals(effect: Effect): void };
type Binding = { effect: Effect; observer: Observer<Effect>; wrapper: DrawWrapper };
const adapted = new WeakSet<NodeMaterial>();
const boundMaterials = new WeakMap<IParticleSystem, NodeMaterial>();

/** The live authored material, shared with capture feedback checks. */
export function particleMaterialForSystem(system: IParticleSystem): NodeMaterial | undefined {
  return boundMaterials.get(system);
}

/**
 * Babylon 9.29's recursive particle binder passes its original empty defines
 * string to a replacement observer. A cached Effect can then append observers
 * indefinitely during the same notification. Keep the current defines and one
 * owned observer per system/blend, without changing Engine or prototype state.
 */
export function prepareNodeMaterialParticleBindings(material: NodeMaterial): void {
  if (adapted.has(material)) return;
  const native = material as unknown as ParticleMaterialInternals;
  const original = native._createEffectForParticles;
  if (typeof original !== "function" || original.length !== 6 || typeof native._checkInternals !== "function") {
    throw new Error("Unsupported Babylon particle material binding layout.");
  }
  const priorDescriptor = Object.getOwnPropertyDescriptor(material, "_createEffectForParticles");
  const systems = new Map<IParticleSystem, {
    bindings: Map<number, Binding>;
    disposeObserver: Observer<IParticleSystem> | null;
    drawObserver: Observer<Effect | null> | null;
  }>();
  const releaseSystem = (system: IParticleSystem) => {
    const owned = systems.get(system);
    if (!owned) return;
    systems.delete(system);
    if (boundMaterials.get(system) === material) boundMaterials.delete(system);
    for (const { effect, observer, wrapper } of owned.bindings.values()) {
      effect.onBindObservable.remove(observer);
      // Native particle disposal omits custom wrappers. Release only the
      // concrete wrapper installed by this material's binding.
      wrapper.dispose();
    }
    system.onDisposeObservable.remove(owned.disposeObserver);
    system.onBeforeDrawParticlesObservable.remove(owned.drawObserver);
  };
  const bind: NativeParticleBinder = function(system, blend, onCompiled, onError, effect, defines, joined) {
    // Material defines and vertex streams depend on the lazily allocated
    // gradient textures. Prepare them before capturing the first custom effect,
    // rather than replacing a mismatched effect during its first native draw.
    if (system instanceof GPUParticleSystem && !effect) system._recreateUpdateEffect();
    let owned = systems.get(system);
    if (!owned) {
      owned = {
        bindings: new Map(),
        disposeObserver: system.onDisposeObservable.addOnce(() => releaseSystem(system)),
        // Emitters' instances of one Material share an Effect (`shareParticleProgram`), and every binding observer on
        // it runs when it is enabled, the last one's values winning, and none when the previous draw used it too.
        // Each draw binds its own system's Material last, right before it draws.
        drawObserver: system.onBeforeDrawParticlesObservable.add((drawn) => {
          if (drawn && boundMaterials.get(system) === material) native._checkInternals(drawn);
        }),
      };
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
    // The pinned setCustomEffect omits the instanced context flag set by its
    // default GPU effect path. GPU particle attributes advance per particle.
    if (system instanceof GPUParticleSystem && wrapper.drawContext) wrapper.drawContext.useInstancing = true;
    owned.bindings.set(blend, { effect: currentEffect, observer, wrapper });
    boundMaterials.set(system, material);
    // DrawWrapper.dispose delays the Effect, but destroys its draw context
    // immediately. A define change occurs inside onBind, before the current
    // WebGPU draw consumes that context: retire the whole wrapper after frame.
    if (previous && previous.wrapper !== wrapper) {
      const retired = previous.wrapper;
      const engine = material.getScene().getEngine();
      const frameObserver = engine.onEndFrameObservable.addOnce(() => {
        engine.onDisposeObservable.remove(disposeObserver);
        retired.dispose();
      });
      const disposeObserver = engine.onDisposeObservable.addOnce(() => {
        engine.onEndFrameObservable.remove(frameObserver);
        retired.dispose(true);
      });
    }
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
