import { ParticleSystem, RawTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(gpuParticlesSupported(false)).toBe(false);
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
});
