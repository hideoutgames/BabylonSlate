import { ParticleSystem, RawTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import { applyParticleLook } from "./particle-system-factory";

describe("compiled particle effect bindings", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });

  async function host() {
    const { scene, engine } = createTestEngine();
    cleanup.push(() => engine.dispose(), () => scene.dispose());
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    const library = new MaterialLibrary();
    cleanup.push(() => library.dispose());
    const compiled = library.acquire(scene, "particle", createDefaultMaterialDocument("Particle", "particle"));
    if (materialUnavailable(compiled)) throw new Error("Particle fixture must compile");
    const create = async (name: string) => {
      const system = new ParticleSystem(name, 16, scene);
      applyParticleLook({ system, material: compiled.material, texture, gpu: false,
        emitter: createDefaultParticleEmitterPayload(), systemPayload: createDefaultParticleSystemPayload() });
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
      ParticleSystem.BILLBOARDMODE_Y, ParticleSystem.BILLBOARDMODE_ALL]) {
      creations = 0;
      const previous = system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
      effects.add(previous);
      system.billboardMode = billboard;
      previous.onBindObservable.notifyObservers(previous);
      const current = system.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE)!;
      const changed = creations;
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
