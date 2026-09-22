import { Effect, NodeMaterial, NodeMaterialModes, ParticleSystem, RawTexture } from "@babylonjs/core";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import {
  PARTICLE_BLENDMODE_STANDARD,
  PARTICLE_BILLBOARDMODE_ALL,
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  normalizeParticleEmitterPayload,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import {
  applyParticleLook,
  bindParticleApplyTarget,
  createBabylonParticleSystem,
  gpuParticlesSupported,
  particleCapacityFor,
} from "./particle-system-factory";

describe("particle-system-factory", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function host() {
    const handle = createTestEngine();
    handles.push(handle);
    const texture = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      handle.scene,
    );
    return { ...handle, texture };
  }

  it("builds a CPU ParticleSystem when GPU is not requested", () => {
    const { scene } = host();
    const system = createBabylonParticleSystem("cpu", scene, 64, false);
    expect(system).toBeInstanceOf(ParticleSystem);
    expect(system.getCapacity()).toBe(64);
  });

  it("does not claim GPU support when the caller opts out", () => {
    expect(gpuParticlesSupported(host().scene.getEngine(), false)).toBe(false);
  });

  it("applies box spawn, standard blend, local space, and drag onto a live system", () => {
    const { scene, texture } = host();
    const system = createBabylonParticleSystem("box", scene, 32, false);
    const emitter = normalizeParticleEmitterPayload({
      ...createDefaultParticleEmitterPayload(),
      blendMode: "standard",
      gravity: [0, -2, 0],
      shape: {
        kind: "box",
        min: [-1, 0, -1],
        max: [1, 1, 1],
        direction1: [0, 1, 0],
        direction2: [0, 1, 0],
      },
      dragGradient: [
        { t: 0, value: 0 },
        { t: 1, value: 0.5 },
      ],
      angularSpeedGradient: [
        { t: 0, value: 0 },
        { t: 1, value: 1 },
      ],
    });
    applyParticleLook({
      system,
      emitter,
      systemPayload: {
        ...createDefaultParticleSystemPayload(),
        space: "local",
        looping: false,
        duration: 1.5,
      },
      gpu: false,
      texture,
      material: null,
    });
    expect(system.particleTexture).toBe(texture);
    expect(system.isBillboardBased).toBe(true);
    expect(system.billboardMode).toBe(PARTICLE_BILLBOARDMODE_ALL);
    expect(system.blendMode).toBe(PARTICLE_BLENDMODE_STANDARD);
    expect(system.isLocal).toBe(true);
    expect(system.targetStopDuration).toBe(1.5);
    expect(system.gravity.y).toBe(-2);
    const bound = bindParticleApplyTarget(system);
    expect(bound.emitRate).toBe(system.emitRate);
    expect(bound.minLifeTime).toBe(system.minLifeTime);
    expect(bound.maxLifeTime).toBe(system.maxLifeTime);
    expect(bound.minEmitPower).toBe(system.minEmitPower);
    expect(bound.maxEmitPower).toBe(system.maxEmitPower);
    expect(bound.minSize).toBe(system.minSize);
    expect(bound.maxSize).toBe(system.maxSize);
    expect(bound.minAngularSpeed).toBe(system.minAngularSpeed);
    expect(bound.maxAngularSpeed).toBe(system.maxAngularSpeed);
    expect(bound.preWarmCycles).toBe(system.preWarmCycles);
    expect(bound.preWarmStepOffset).toBe(system.preWarmStepOffset);
    expect(bound.capacity).toBe(system.getCapacity());
    expect(bound.gravity).toEqual(system.gravity);
    expect(particleCapacityFor(emitter, false)).toBe(emitter.capacity);
    system.dispose(false);
  });

  it("applies sphere and cone emitters", () => {
    const { scene, texture } = host();
    const sphere = createBabylonParticleSystem("sphere", scene, 16, false);
    applyParticleLook({
      system: sphere,
      emitter: normalizeParticleEmitterPayload({
        ...createDefaultParticleEmitterPayload(),
        shape: { kind: "sphere", radius: 0.4, radiusRange: 0.5 },
      }),
      systemPayload: createDefaultParticleSystemPayload(),
      gpu: false,
      texture,
      material: null,
    });
    expect(sphere.particleTexture).toBe(texture);
    sphere.dispose(false);

    const cone = createBabylonParticleSystem("cone", scene, 16, false);
    applyParticleLook({
      system: cone,
      emitter: normalizeParticleEmitterPayload({
        ...createDefaultParticleEmitterPayload(),
        shape: { kind: "cone", radius: 0.2, angle: 0.4 },
      }),
      systemPayload: createDefaultParticleSystemPayload(),
      gpu: false,
      texture,
      material: null,
    });
    expect(cone.particleTexture).toBe(texture);
    cone.dispose(false);
  });

  it("copies particleTexture onto ParticleTextureBlock before createEffectForParticles", async () => {
    const { scene, texture } = host();
    const system = createBabylonParticleSystem("nme", scene, 16, false);
    const block = new ParticleTextureBlock("particleTex");
    let boundDuringEffect: unknown = null;
    const material = new NodeMaterial("particle", scene);
    material.mode = NodeMaterialModes.Particle;
    material.attachedBlocks.push(block);
    material.createEffectForParticles = () => { boundDuringEffect = block.texture; };
    applyParticleLook({
      system,
      emitter: createDefaultParticleEmitterPayload(),
      systemPayload: createDefaultParticleSystemPayload(),
      gpu: false,
      texture,
      material,
    });
    await vi.waitFor(() => expect(boundDuringEffect).toBe(texture));
    expect(block.texture).toBe(texture);
    expect(system.particleTexture).toBe(texture);
    system.dispose(false);
  });

  it("waits for actual compiled particle source before creating effects", async () => {
    const { scene, texture } = host();
    const library = new MaterialLibrary();
    const acquired = library.acquire(scene, "particle-source", createDefaultMaterialDocument("Sparks", "particle"));
    if (materialUnavailable(acquired)) throw new Error("Particle fixture must compile");
    const registered = vi.spyOn(Effect, "RegisterShader");
    const effectCreation = vi.spyOn(acquired.material, "createEffectForParticles");
    const system = createBabylonParticleSystem("compiled", scene, 16, false);
    applyParticleLook({ system, emitter: createDefaultParticleEmitterPayload(),
      systemPayload: createDefaultParticleSystemPayload(), gpu: false, texture, material: acquired.material });
    expect(effectCreation).not.toHaveBeenCalled();
    await acquired.ready;
    await vi.waitFor(() => expect(effectCreation).toHaveBeenCalledOnce());
    expect(registered.mock.calls.length).toBeGreaterThan(0);
    // Empty registration makes Babylon fall back to fetching a generated .fx URL.
    for (const [, source] of registered.mock.calls) expect(source).toContain("void main");
    for (const blend of [ParticleSystem.BLENDMODE_ONEONE, ParticleSystem.BLENDMODE_MULTIPLY]) {
      await vi.waitFor(() => expect(system.getCustomEffect(blend)?.fragmentSourceCode).toContain("void main"));
    }
    system.dispose(false);
    library.dispose();
  });

  it("does not bind an obsolete material after replacement or system disposal", async () => {
    const { scene, texture } = host();
    const library = new MaterialLibrary();
    const first = library.acquire(scene, "first", createDefaultMaterialDocument("First", "particle"));
    const second = library.acquire(scene, "second", createDefaultMaterialDocument("Second", "particle"));
    if (materialUnavailable(first) || materialUnavailable(second)) throw new Error("Particle fixtures must compile");
    const oldEffect = vi.spyOn(first.material, "createEffectForParticles");
    const newEffect = vi.spyOn(second.material, "createEffectForParticles");
    const live = createBabylonParticleSystem("live", scene, 16, false);
    const removed = createBabylonParticleSystem("removed", scene, 16, false);
    const apply = (system: typeof live, material: NodeMaterial | null) => applyParticleLook({ system,
      emitter: createDefaultParticleEmitterPayload(), systemPayload: createDefaultParticleSystemPayload(),
      gpu: false, texture, material });
    apply(live, first.material);
    apply(live, second.material);
    apply(removed, first.material);
    removed.dispose(false);
    await Promise.all([first.ready, second.ready]);
    await vi.waitFor(() => expect(newEffect).toHaveBeenCalledOnce());
    expect(newEffect).toHaveBeenCalledWith(live);
    expect(oldEffect).not.toHaveBeenCalled();
    live.dispose(false);
    library.dispose();
  });
});
