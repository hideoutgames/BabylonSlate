import { Color4, MeshBuilder, NodeMaterialModes, ParticleSystem, RawTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  PARTICLE_BLENDMODE_ONEONE,
  PARTICLE_BILLBOARDMODE_ALL,
  PARTICLE_CPU_FALLBACK_CAPACITY,
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  normalizeParticleEmitterPayload,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ParticleService } from "./particle-service";

describe("ParticleService", () => {
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
    const emitterMesh = MeshBuilder.CreateBox("emitter", { size: 0.1 }, handle.scene);
    const service = new ParticleService({
      scene: handle.scene,
      gpuSupported: false,
      resolveTexture: (guid) => (guid === "tex-1" ? texture : null),
      resolveEmitter: (slotId) => (slotId === 1 ? emitterMesh : null),
    });
    return { ...handle, service, texture, emitterMesh };
  }

  it("constructs a CPU ParticleSystem, applies billboard quads, and starts on play", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            capacity: 128,
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          {
            ...createDefaultParticleSystemPayload(),
            emitterGuids: ["em-1"],
          },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    expect(scene.particleSystems).toHaveLength(1);
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system).toBeInstanceOf(ParticleSystem);
    expect(system.isBillboardBased).toBe(true);
    expect(system.billboardMode).toBe(PARTICLE_BILLBOARDMODE_ALL);
    expect(system.blendMode).toBe(PARTICLE_BLENDMODE_ONEONE);
    expect(system.particleTexture).toBeTruthy();
    expect(system.isStarted()).toBe(true);
    expect(service.stats()).toMatchObject({ systems: 1, playing: 1, gpu: false });
    service.dispose();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.stats().systems).toBe(0);
  });

  it("caps CPU fallback capacity at 512", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            capacity: 4096,
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system.getCapacity()).toBe(PARTICLE_CPU_FALLBACK_CAPACITY);
    service.dispose();
  });

  it("diagnoses a missing texture without throwing and skips that emitter", () => {
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const { scene, service } = host();
    service.setOnDiagnostic((entry) => diagnostics.push(entry));
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "missing",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    expect(() =>
      service.handleCommand({
        type: "assignParticle",
        slotId: 1,
        actorGuid: "fx",
        componentId: "particle-1",
        particleSystemGuid: "sys-1",
        play: true,
      }),
    ).not.toThrow();
    expect(scene.particleSystems).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "particle.missing_texture",
        assetGuid: "em-1",
      }),
    ]);
    service.dispose();
  });

  it("stops with stop() and disposes on resetSession so GPU leftovers cannot linger", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    const system = scene.particleSystems[0] as ParticleSystem;
    service.handleCommand({
      type: "setParticlePlaying",
      actorGuid: "fx",
      componentId: "particle-1",
      playing: false,
    });
    expect(service.stats().playing).toBe(0);
    expect(scene.particleSystems).toHaveLength(1);
    service.handleCommand({
      type: "setParticlePlaying",
      actorGuid: "fx",
      playing: true,
    });
    expect(service.stats().playing).toBe(1);
    expect(system.isStarted()).toBe(true);
    service.resetSession();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.stats().playing).toBe(0);
  });

  it("starts one Babylon system per Particle Emitter slot", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          }),
        ],
        [
          "em-2",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            blendMode: "standard",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          {
            ...createDefaultParticleSystemPayload(),
            emitterGuids: ["em-1", "em-2"],
          },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    expect(scene.particleSystems).toHaveLength(2);
    expect(service.stats().systems).toBe(2);
    service.dispose();
  });

  it("disposes live systems when assignParticle clears the guid", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: null,
    });
    expect(scene.particleSystems).toHaveLength(0);
    service.dispose();
  });

  it("applies color gradients onto the live system", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            colorGradient: [
              { t: 0, color: [1, 0, 0, 1] },
              { t: 1, color: [0, 0, 1, 0] },
            ],
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    const system = scene.particleSystems[0] as ParticleSystem;
    const colors = system.getColorGradients();
    expect(colors?.length).toBeGreaterThanOrEqual(2);
    expect(colors?.[0]?.color1).toBeInstanceOf(Color4);
    service.dispose();
  });

  it("diagnoses unknown Particle System and Emitter assets", () => {
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const { scene, service } = host();
    service.setOnDiagnostic((entry) => diagnostics.push(entry));
    service.setLibrary({
      emitters: new Map(),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["missing"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "missing-sys",
      play: true,
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    expect(scene.particleSystems).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "particle.unknown_system",
        assetGuid: "missing-sys",
      }),
      expect.objectContaining({
        code: "particle.unknown_emitter",
        assetGuid: "missing",
      }),
    ]);
    service.dispose();
  });

  it("assigns without starting when play is false, then parents onto bindSlot", () => {
    const { scene, service, emitterMesh } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 2,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: false,
    });
    expect(service.stats().playing).toBe(0);
    expect(scene.particleSystems).toHaveLength(1);
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system.isStarted()).toBe(false);
    service.bindSlot(2, emitterMesh);
    const emitter = system.emitter as { parent?: unknown };
    expect(emitter.parent).toBe(emitterMesh);
    service.dispose();
  });

  it("maps ParticleComponent sorting layer onto renderingGroupId", () => {
    const { scene, service } = host();
    service.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    service.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
      sortingLayer: "UI",
      orderInLayer: 3,
    });
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system.renderingGroupId).toBe(3);
    service.dispose();
  });

  it("applies a particle-domain material with createEffectForParticles", () => {
    const { scene, service, texture } = host();
    const attached: unknown[] = [];
    const material = {
      mode: NodeMaterialModes.Particle,
      createEffectForParticles: (system: unknown) => {
        attached.push(system);
      },
    };
    const withMaterial = new ParticleService({
      scene,
      gpuSupported: false,
      resolveTexture: (guid) => (guid === "tex-1" ? texture : null),
      resolveMaterial: (guid) =>
        guid === "mat-1" ? (material as never) : null,
    });
    withMaterial.setLibrary({
      emitters: new Map([
        [
          "em-1",
          normalizeParticleEmitterPayload({
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            materialGuid: "mat-1",
          }),
        ],
      ]),
      systems: new Map([
        [
          "sys-1",
          { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
        ],
      ]),
    });
    withMaterial.handleCommand({
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
    });
    expect(attached).toHaveLength(1);
    expect(attached[0]).toBe(scene.particleSystems[0]);
    withMaterial.dispose();
    service.dispose();
  });
});
