import { DrawWrapper, ParticleSystem, type Effect, type Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultMaterialDocument } from "@haptic/shader-graph";
import { createTestEngine } from "./create-null-engine";
import { keepPlayEffects } from "./effect-bridge";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import { bindParticleMaterial } from "./particle-system-factory";

describe("compiled particle effect bindings", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });

  async function host() {
    const { scene, engine } = createTestEngine();
    cleanup.push(() => engine.dispose(), () => scene.dispose());
    const library = new MaterialLibrary();
    cleanup.push(() => library.dispose());
    const compiled = library.acquire(scene, "particle", createDefaultMaterialDocument("Particle", "particle"));
    if (materialUnavailable(compiled)) throw new Error("Particle fixture must compile");
    const create = async (name: string) => {
      const system = new ParticleSystem(name, 16, scene);
      void bindParticleMaterial(system, compiled.material);
      await compiled.ready;
      await vi.waitFor(() => expect(system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)).toBeTruthy());
      return system;
    };
    return { engine, scene, create, library, compiled };
  }

  it("settles live define changes without appending callbacks during the same bind", async () => {
    const { engine, create } = await host();
    const system = await create("changing");
    const nativeCreate = engine.createEffectForParticles.bind(engine);
    let creations = 0;
    vi.spyOn(engine, "createEffectForParticles").mockImplementation((...args) => {
      // The broken native binder never returns. Fail at this GPU boundary rather
      // than hanging the test while it appends callbacks to a cached effect.
      if (++creations > 8) throw new Error("Particle effect recreation did not settle.");
      return nativeCreate(...args);
    });
    const effects = new Set<NonNullable<ReturnType<typeof system.getCustomEffect>>>();
    for (const billboard of [ParticleSystem.BILLBOARDMODE_Y, ParticleSystem.BILLBOARDMODE_ALL,
      ParticleSystem.BILLBOARDMODE_STRETCHED, ParticleSystem.BILLBOARDMODE_ALL]) {
      creations = 0;
      const previous = system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
      effects.add(previous);
      const wrapper = (system as unknown as { _customWrappers: Record<number, DrawWrapper> })._customWrappers[ParticleSystem.BLENDMODE_ONEONE]!;
      const dispose = vi.spyOn(wrapper, "dispose");
      system.billboardMode = billboard;
      previous.onBindObservable.notifyObservers(previous);
      const current = system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
      const changed = creations;
      expect(dispose).not.toHaveBeenCalled();
      engine.endFrame();
      expect(dispose).toHaveBeenCalledOnce();
      // Babylon binds only ready effects; particle Materials carry uniforms (the Multiply blend alpha).
      await vi.waitFor(() => expect(current.isReady()).toBe(true));
      current.onBindObservable.notifyObservers(current);
      current.onBindObservable.notifyObservers(current);
      expect(creations).toBe(changed);
      await vi.waitFor(() => expect(current.onBindObservable.observers).toHaveLength(1));
      effects.add(current);
    }
    system.dispose(false);
    await vi.waitFor(() => {
      for (const effect of effects) expect(effect.onBindObservable.hasObservers()).toBe(false);
    });
    await vi.waitFor(() => {
      engine.endFrame();
      for (const effect of effects) expect(effect.isDisposed).toBe(true);
    });
  });

  it("releases only the disposed system's observers on a shared effect", async () => {
    const { create, library } = await host();
    const first = await create("first"), second = await create("second");
    const effect = second.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
    expect(first.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)).toBe(effect);
    first.dispose(false);
    await vi.waitFor(() => expect(effect.onBindObservable.observers).toHaveLength(1));
    expect(() => effect.onBindObservable.notifyObservers(effect)).not.toThrow();
    library.dispose();
    await vi.waitFor(() => expect(effect.onBindObservable.hasObservers()).toBe(false));
  });

  /** An emitter's own instance of the particle Material, as `acquireParticleMaterial` takes it, bound to a system. */
  async function emitter(scene: Scene, library: MaterialLibrary, instanceKey: string) {
    const compiled = library.acquire(scene, "particle", createDefaultMaterialDocument("Particle", "particle"), { instanceKey });
    if (materialUnavailable(compiled)) throw new Error("Particle fixture must compile");
    const system = new ParticleSystem(instanceKey, 16, scene);
    void bindParticleMaterial(system, compiled.material);
    await compiled.ready;
    await vi.waitFor(() => expect(system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)).toBeTruthy());
    return { system, material: compiled.material, effect: system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)! };
  }

  it("shares one program between emitters' instances of a Material, and draws each with its own instance", async () => {
    const { scene, library } = await host();
    const first = await emitter(scene, library, "first"), second = await emitter(scene, library, "second");
    expect(second.material).not.toBe(first.material);
    expect(second.effect).toBe(first.effect);
    // Enabling the shared Effect runs every system's binding observer, the last one's values winning: each draw
    // binds its own system's Material right before it draws.
    type Bindings = { _checkInternals(effect: Effect): void };
    const firstBinds = vi.spyOn(first.material as unknown as Bindings, "_checkInternals");
    const secondBinds = vi.spyOn(second.material as unknown as Bindings, "_checkInternals");
    first.system.onBeforeDrawParticlesObservable.notifyObservers(first.effect);
    expect(firstBinds).toHaveBeenCalledWith(first.effect);
    expect(secondBinds).not.toHaveBeenCalled();
  });

  it("names a later emitter's program after an earlier one of the same code, so the program Play kept serves it", async () => {
    const { engine, scene, library } = await host();
    const stop = keepPlayEffects(engine);
    cleanup.push(stop);
    const first = await emitter(scene, library, "first");
    first.system.dispose(false);
    library.release(scene, "particle", { instanceKey: "first" });
    await vi.waitFor(() => expect(first.effect.onBindObservable.hasObservers()).toBe(false));
    // The system's draw wrapper lets its Effect go at a frame's end.
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.endFrame();
    // The next session's emitter compiles a new instance of the same Material.
    const later = await emitter(scene, library, "later");
    expect(later.effect).toBe(first.effect);
  });

  it("removes compiler probe bindings before a live system reuses their effect", async () => {
    const { scene, create, compiled } = await host();
    await compiled.ready;
    // The compiler's temporary shader probe precedes the first factory binding.
    const probe = new ParticleSystem("compile-probe", 1, scene);
    compiled.material.createEffectForParticles(probe);
    const live = await create("live");
    const effect = live.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
    expect(probe.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)).toBe(effect);
    probe.dispose(false);
    await vi.waitFor(() => expect(effect.onBindObservable.observers).toHaveLength(1));
    expect(() => effect.onBindObservable.notifyObservers(effect)).not.toThrow();
    live.dispose(false);
  });
});
