import { describe, expect, it } from "vitest";
import {
  PARTICLE_BILLBOARDMODE_ALL,
  PARTICLE_BLENDMODE_ONEONE,
  PARTICLE_BLENDMODE_STANDARD,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_CPU_FALLBACK_CAPACITY,
  PARTICLE_SYSTEM_MAX_EMITTERS,
  applyParticleEmitterPayload,
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  normalizeParticleEmitterPayload,
  normalizeParticleSystemPayload,
  particleAssetDependencies,
  remapParticlePayloadGuids,
  resolveParticleEmitterCapacity,
  resolveParticleReferences,
  type ParticleApplyTarget,
} from "./particle-payload";
import { encodeAssetDocument, decodeAssetDocument } from "./asset-document";
import { loadPayloadWithMigration } from "./migrate-on-load";
import { createDefaultMigrationRegistry } from "./migration";

type FakeTarget = ParticleApplyTarget & {
  colorKeys: Array<{
    t: number;
    color: { r: number; g: number; b: number; a: number };
  }>;
  sizeKeys: Array<{ t: number; value: number }>;
  angularKeys: Array<{ t: number; value: number }>;
  dragKeys: Array<{ t: number; value: number }>;
  shapeCalls: unknown[];
};

function createFakeParticleApplyTarget(): FakeTarget {
  const target: FakeTarget = {
    emitRate: 0,
    minLifeTime: 0,
    maxLifeTime: 0,
    minEmitPower: 0,
    maxEmitPower: 0,
    gravity: { x: 0, y: 0, z: 0 },
    minSize: 0,
    maxSize: 0,
    minAngularSpeed: 0,
    maxAngularSpeed: 0,
    isLocal: false,
    isBillboardBased: false,
    billboardMode: 0,
    blendMode: 0,
    preWarmCycles: 0,
    preWarmStepOffset: 0,
    targetStopDuration: 0,
    capacity: 0,
    colorKeys: [],
    sizeKeys: [],
    angularKeys: [],
    dragKeys: [],
    shapeCalls: [],
    addColorGradient(gradient, color) {
      target.colorKeys.push({ t: gradient, color });
    },
    addSizeGradient(gradient, factor) {
      target.sizeKeys.push({ t: gradient, value: factor });
    },
    addAngularSpeedGradient(gradient, factor) {
      target.angularKeys.push({ t: gradient, value: factor });
    },
    addDragGradient(gradient, factor) {
      target.dragKeys.push({ t: gradient, value: factor });
    },
    createPointEmitter(direction1, direction2) {
      target.shapeCalls.push({ kind: "point", direction1, direction2 });
      return {};
    },
    createBoxEmitter(direction1, direction2, min, max) {
      target.shapeCalls.push({
        kind: "box",
        direction1,
        direction2,
        min,
        max,
      });
      return {};
    },
    createSphereEmitter(radius, radiusRange) {
      target.shapeCalls.push({ kind: "sphere", radius, radiusRange });
      return {};
    },
    createConeEmitter(radius, angle) {
      target.shapeCalls.push({ kind: "cone", radius, angle });
      return {};
    },
  };
  return target;
}

describe("particle payloads", () => {
  it("defaults an Emitter onto the GPU-safe IParticleSystem subset", () => {
    expect(createDefaultParticleEmitterPayload()).toEqual({
      textureGuid: null,
      materialGuid: null,
      capacity: PARTICLE_CAPACITY_DEFAULT,
      emitRate: 30,
      shape: {
        kind: "point",
        direction1: [0, 1, 0],
        direction2: [0, 1, 0],
      },
      minLifeTime: 0.8,
      maxLifeTime: 1.2,
      minEmitPower: 1,
      maxEmitPower: 2,
      gravity: [0, 0, 0],
      minSize: 0.2,
      maxSize: 0.4,
      sizeGradient: [
        { t: 0, value: 1 },
        { t: 1, value: 0 },
      ],
      colorGradient: [
        { t: 0, color: [1, 1, 1, 1] },
        { t: 1, color: [1, 1, 1, 0] },
      ],
      minAngularSpeed: 0,
      maxAngularSpeed: 0,
      angularSpeedGradient: null,
      dragGradient: null,
      blendMode: "additive",
      preWarmCycles: 0,
      preWarmStepOffset: 1,
    });
    expect(PARTICLE_CAPACITY_DEFAULT).toBe(256);
    expect(PARTICLE_CAPACITY_MIN).toBe(16);
    expect(PARTICLE_CAPACITY_MAX).toBe(4096);
    expect(PARTICLE_CPU_FALLBACK_CAPACITY).toBe(512);
    expect(PARTICLE_SYSTEM_MAX_EMITTERS).toBe(8);
  });

  it("defaults a System to a looping world-space emitter list", () => {
    expect(createDefaultParticleSystemPayload()).toEqual({
      emitterGuids: [],
      space: "world",
      looping: true,
      duration: 2,
    });
  });

  it("clamps capacity, rate, and inverted lifetimes on normalize", () => {
    const payload = normalizeParticleEmitterPayload({
      capacity: 99999,
      emitRate: -4,
      minLifeTime: 3,
      maxLifeTime: 1,
      minSize: -1,
      maxSize: 0,
      preWarmCycles: 10_000,
    });
    expect(payload.capacity).toBe(PARTICLE_CAPACITY_MAX);
    expect(payload.emitRate).toBe(0);
    expect(payload.minLifeTime).toBe(1);
    expect(payload.maxLifeTime).toBe(3);
    expect(payload.minSize).toBe(0);
    expect(payload.preWarmCycles).toBeLessThanOrEqual(60);
    expect(normalizeParticleEmitterPayload({ capacity: 1 }).capacity).toBe(
      PARTICLE_CAPACITY_MIN,
    );
  });

  it("keeps 2–8 sorted single-value gradient keys and drops extras", () => {
    const payload = normalizeParticleEmitterPayload({
      colorGradient: [
        { t: 1.4, color: [0, 0, 1, 1] },
        { t: 0.25, color: [1, 0, 0, 1] },
        { t: 0.25, color: [0, 1, 0, 1] },
        ...Array.from({ length: 10 }, (_, i) => ({
          t: i / 10,
          color: [1, 1, 1, 1],
        })),
      ],
      sizeGradient: [{ t: 0.5, value: 2 }],
    });
    expect(payload.colorGradient.length).toBeLessThanOrEqual(8);
    expect(payload.colorGradient.length).toBeGreaterThanOrEqual(2);
    expect(payload.colorGradient[0]!.t).toBe(0);
    expect(payload.colorGradient.at(-1)!.t).toBe(1);
    expect(payload.sizeGradient).toEqual([
      { t: 0, value: 1 },
      { t: 1, value: 0 },
    ]);
  });

  it("normalizes drag to 0 and 1 keys only", () => {
    const payload = normalizeParticleEmitterPayload({
      dragGradient: [
        { t: 0.2, value: 0.1 },
        { t: 0, value: 0 },
        { t: 1, value: 1 },
        { t: 0.9, value: 0.8 },
      ],
    });
    expect(payload.dragGradient).toEqual([
      { t: 0, value: 0 },
      { t: 1, value: 1 },
    ]);
  });

  it("clamps a System to eight emitter guids and drops blanks", () => {
    const payload = normalizeParticleSystemPayload({
      emitterGuids: [
        "a",
        "",
        "b",
        "a",
        ...Array.from({ length: 10 }, (_, i) => `e${i}`),
      ],
      space: "local",
      looping: false,
      duration: -1,
    });
    expect(payload.emitterGuids).toHaveLength(PARTICLE_SYSTEM_MAX_EMITTERS);
    expect(payload.emitterGuids[0]).toBe("a");
    expect(payload.emitterGuids).not.toContain("");
    expect(payload.space).toBe("local");
    expect(payload.looping).toBe(false);
    expect(payload.duration).toBe(0);
  });

  it("indexes Emitter texture/material and System emitter guid dependencies", () => {
    expect(
      particleAssetDependencies("ParticleEmitter", {
        textureGuid: "tex-1",
        materialGuid: "mat-1",
      }),
    ).toEqual(["mat-1", "tex-1"]);
    expect(
      particleAssetDependencies("ParticleSystem", {
        emitterGuids: ["em-2", "em-1", "em-2"],
      }),
    ).toEqual(["em-1", "em-2"]);
    expect(particleAssetDependencies("Audio", {})).toEqual([]);
  });

  it("falls missing Emitter and System references back with diagnostics", () => {
    const emitter = resolveParticleReferences(
      "ParticleEmitter",
      {
        textureGuid: "gone-tex",
        materialGuid: "kept-mat",
      },
      new Set(["kept-mat"]),
    );
    expect(emitter.payload).toMatchObject({
      textureGuid: null,
      materialGuid: "kept-mat",
    });
    expect(emitter.diagnostics.map((row) => row.code)).toEqual([
      "particle.missing_texture",
    ]);

    const system = resolveParticleReferences(
      "ParticleSystem",
      { emitterGuids: ["kept-em", "gone-em"] },
      new Set(["kept-em"]),
    );
    expect(system.payload).toMatchObject({ emitterGuids: ["kept-em"] });
    expect(system.diagnostics.map((row) => row.code)).toEqual([
      "particle.missing_emitter",
    ]);
  });

  it("remaps Emitter and System guids on import collision", () => {
    const remap = new Map([
      ["tex-old", "tex-new"],
      ["em-old", "em-new"],
    ]);
    expect(
      remapParticlePayloadGuids(
        "ParticleEmitter",
        { textureGuid: "tex-old", materialGuid: "mat-1" },
        remap,
      ),
    ).toMatchObject({ textureGuid: "tex-new", materialGuid: "mat-1" });
    expect(
      remapParticlePayloadGuids(
        "ParticleSystem",
        { emitterGuids: ["em-old", "em-keep"] },
        remap,
      ),
    ).toMatchObject({ emitterGuids: ["em-new", "em-keep"] });
  });

  it("drops CPU fallback capacity without changing the authored GPU capacity", () => {
    expect(resolveParticleEmitterCapacity(2048, true)).toBe(2048);
    expect(resolveParticleEmitterCapacity(2048, false)).toBe(
      PARTICLE_CPU_FALLBACK_CAPACITY,
    );
    expect(resolveParticleEmitterCapacity(64, false)).toBe(64);
  });

  it("applies an Emitter onto a fake IParticleSystem (billboard quads, gradients, blend)", () => {
    const payload = normalizeParticleEmitterPayload({
      capacity: 1024,
      emitRate: 40,
      blendMode: "standard",
      shape: {
        kind: "box",
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
        direction1: [0, 1, 0],
        direction2: [0, 1, 0],
      },
      colorGradient: [
        { t: 0, color: [1, 0, 0, 1] },
        { t: 1, color: [1, 1, 0, 0] },
      ],
      sizeGradient: [
        { t: 0, value: 1 },
        { t: 1, value: 0.2 },
      ],
      angularSpeedGradient: [
        { t: 0, value: 0 },
        { t: 1, value: 2 },
      ],
      dragGradient: [
        { t: 0, value: 0 },
        { t: 1, value: 0.5 },
      ],
      gravity: [0, -2, 0],
      preWarmCycles: 8,
      preWarmStepOffset: 0.5,
    });
    const target = createFakeParticleApplyTarget();
    const applied = applyParticleEmitterPayload(payload, target, {
      space: "local",
      looping: false,
      duration: 1.5,
      gpuSupported: true,
    });
    expect(applied.appliedCapacity).toBe(1024);
    expect(target.emitRate).toBe(40);
    expect(target.isBillboardBased).toBe(true);
    expect(target.billboardMode).toBe(PARTICLE_BILLBOARDMODE_ALL);
    expect(target.blendMode).toBe(PARTICLE_BLENDMODE_STANDARD);
    expect(target.isLocal).toBe(true);
    expect(target.targetStopDuration).toBe(1.5);
    expect(target.preWarmCycles).toBe(8);
    expect(target.gravity).toEqual({ x: 0, y: -2, z: 0 });
    expect(target.shapeCalls).toEqual([
      {
        kind: "box",
        direction1: { x: 0, y: 1, z: 0 },
        direction2: { x: 0, y: 1, z: 0 },
        min: { x: -0.5, y: 0, z: -0.5 },
        max: { x: 0.5, y: 1, z: 0.5 },
      },
    ]);
    expect(target.colorKeys).toEqual([
      { t: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { t: 1, color: { r: 1, g: 1, b: 0, a: 0 } },
    ]);
    expect(target.sizeKeys).toHaveLength(2);
    expect(target.angularKeys).toHaveLength(2);
    expect(target.dragKeys).toEqual([
      { t: 0, value: 0 },
      { t: 1, value: 0.5 },
    ]);
  });

  it("applies additive blend, point emitters, and looping with no stop duration", () => {
    const payload = createDefaultParticleEmitterPayload();
    const target = createFakeParticleApplyTarget();
    applyParticleEmitterPayload(payload, target, {
      space: "world",
      looping: true,
      duration: 99,
      gpuSupported: false,
    });
    expect(target.blendMode).toBe(PARTICLE_BLENDMODE_ONEONE);
    expect(target.isLocal).toBe(false);
    expect(target.targetStopDuration).toBe(0);
    expect(target.shapeCalls[0]).toMatchObject({ kind: "point" });
    expect(target.capacity).toBe(PARTICLE_CAPACITY_DEFAULT);
  });

  it("maps sphere and cone shapes onto create*Emitter", () => {
    const sphere = createFakeParticleApplyTarget();
    applyParticleEmitterPayload(
      normalizeParticleEmitterPayload({
        shape: { kind: "sphere", radius: 2, radiusRange: 0.5 },
      }),
      sphere,
      { space: "world", looping: true, duration: 1, gpuSupported: true },
    );
    expect(sphere.shapeCalls).toEqual([
      { kind: "sphere", radius: 2, radiusRange: 0.5 },
    ]);

    const cone = createFakeParticleApplyTarget();
    applyParticleEmitterPayload(
      normalizeParticleEmitterPayload({
        shape: { kind: "cone", radius: 0.4, angle: 0.5 },
      }),
      cone,
      { space: "world", looping: true, duration: 1, gpuSupported: true },
    );
    expect(cone.shapeCalls).toEqual([{ kind: "cone", radius: 0.4, angle: 0.5 }]);
  });

  it("round-trips Emitter and System documents", async () => {
    const emitter = createDefaultParticleEmitterPayload();
    emitter.textureGuid = "tex-1";
    const encoded = await encodeAssetDocument({
      type: "ParticleEmitter",
      name: "Sparks",
      guid: "00000000-0000-4000-8000-00000000e001",
      version: 1,
      payload: emitter as unknown as Record<string, unknown>,
    });
    const decoded = await decodeAssetDocument(encoded);
    expect(decoded.type).toBe("ParticleEmitter");
    expect(normalizeParticleEmitterPayload(decoded.payload)).toEqual(emitter);

    const system = normalizeParticleSystemPayload({
      emitterGuids: ["em-1", "em-1"],
      space: "local",
      looping: false,
      duration: 3,
    });
    const encodedSystem = await encodeAssetDocument({
      type: "ParticleSystem",
      name: "Fire",
      guid: "00000000-0000-4000-8000-00000000s001",
      version: 1,
      payload: system as unknown as Record<string, unknown>,
    });
    const decodedSystem = await decodeAssetDocument(encodedSystem);
    expect(decodedSystem.type).toBe("ParticleSystem");
    expect(normalizeParticleSystemPayload(decodedSystem.payload)).toEqual(
      system,
    );
  });

  it("migrates empty v0 Emitter and System payloads to defaults", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("ParticleEmitter")).toBe(1);
    expect(registry.currentVersion("ParticleSystem")).toBe(1);
    const emitter = loadPayloadWithMigration(registry, {
      type: "ParticleEmitter",
      version: 0,
      payload: {},
      path: "assets/Sparks.emitter.babasset",
    });
    expect(emitter.version).toBe(1);
    expect(normalizeParticleEmitterPayload(emitter.payload)).toEqual(
      createDefaultParticleEmitterPayload(),
    );
    const system = loadPayloadWithMigration(registry, {
      type: "ParticleSystem",
      version: 0,
      payload: {},
      path: "assets/Fire.particles.babasset",
    });
    expect(system.pending).not.toBeNull();
    expect(normalizeParticleSystemPayload(system.payload)).toEqual(
      createDefaultParticleSystemPayload(),
    );
  });
});
