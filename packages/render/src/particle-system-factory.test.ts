import { Color4, Effect, NodeMaterial, NodeMaterialModes, ParticleSystem, Vector3, type Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import {
  normalizeParticleEmitterPayload,
  resolveBasicEmitterPlan,
  type ParticleBlendMode,
} from "@babylonslate/assets";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import { createTestEngine } from "./create-null-engine";
import {
  applyBasicEmitterPlan,
  bindParticleMaterial,
  createBabylonParticleSystem,
  gpuParticlesSupported,
  particleLifetimeBound,
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
    return handle;
  }

  /** A started CPU system at the origin with the Basic plan applied. */
  function cpuSystem(scene: Scene, payload: Record<string, unknown>): ParticleSystem {
    const plan = resolveBasicEmitterPlan(normalizeParticleEmitterPayload(payload), { backend: "cpu", space: "world" });
    const system = createBabylonParticleSystem("basic", scene, plan.capacity, false) as ParticleSystem;
    system.emitter = Vector3.Zero();
    applyBasicEmitterPlan(system, plan, "create");
    system.start(0);
    return system;
  }

  /**
   * NullEngine never readies the readiness texture, so step the native CPU simulation
   * through its prewarm path: one step is updateSpeed × preWarmStepOffset (1) = 1/60 s.
   */
  function step(system: ParticleSystem, frames: number): void {
    for (let frame = 0; frame < frames; frame += 1) system.animate(true);
  }

  const still = { speed: { mode: "constant", value: 0 } };

  it("builds a CPU ParticleSystem when GPU is not requested", () => {
    const { scene } = host();
    const system = createBabylonParticleSystem("cpu", scene, 64, false);
    expect(system).toBeInstanceOf(ParticleSystem);
    expect(system.getCapacity()).toBe(64);
  });

  it("does not claim GPU support when the caller opts out", () => {
    expect(gpuParticlesSupported(host().scene.getEngine(), false)).toBe(false);
  });

  it("claims the whole GPU slot ring at construction and after reset", () => {
    const { scene, engine } = host();
    vi.spyOn(engine, "getCaps").mockReturnValue({ ...engine.getCaps(), supportTransformFeedbacks: true });
    const system = createBabylonParticleSystem("ring", scene, 64, true);
    // Overlapping bursts would otherwise overwrite live particles in a ring sized by rate × lifetime.
    expect(system.getActiveCount()).toBe(64);
    system.reset();
    expect(system.getActiveCount()).toBe(64);
    system.dispose();
  });

  it("gives each system its own readiness texture and releases it with the system", () => {
    const { scene } = host();
    const baseline = scene.textures.length;
    const first = createBabylonParticleSystem("first", scene, 16, false);
    const second = createBabylonParticleSystem("second", scene, 16, false);
    expect(first.particleTexture).toBeTruthy();
    expect(first.particleTexture).not.toBe(second.particleTexture);
    first.dispose();
    second.dispose();
    expect(scene.textures).toHaveLength(baseline);
  });

  it.each([
    ["additive", ParticleSystem.BLENDMODE_ONEONE],
    ["standard", ParticleSystem.BLENDMODE_STANDARD],
    ["add", ParticleSystem.BLENDMODE_ADD],
    ["multiply", ParticleSystem.BLENDMODE_MULTIPLY],
    ["subtract", ParticleSystem.BLENDMODE_SUBTRACT],
  ] as Array<[ParticleBlendMode, number]>)("draws Blend Mode %s with Babylon's named constant", (blendMode, constant) => {
    const { scene } = host();
    const system = cpuSystem(scene, { render: { blendMode } });
    expect(system.blendMode).toBe(constant);
  });

  it("measures rate and lifetime in seconds", () => {
    const { scene } = host();
    const system = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 60 } },
      initialize: { ...still, lifetime: { mode: "constant", value: 0.5 } },
    });
    step(system, 60);
    expect(system.getActiveCount()).toBeGreaterThanOrEqual(27);
    expect(system.getActiveCount()).toBeLessThanOrEqual(33);
  });

  it("stops a Once emitter after its Duration in seconds", () => {
    const { scene } = host();
    const system = cpuSystem(scene, { emitter: { loop: "once", duration: 0.5 } });
    const stopped = vi.fn();
    system.onStoppedObservable.add(stopped);
    step(system, 29);
    expect(stopped).not.toHaveBeenCalled();
    step(system, 2);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("starts and emits a looping emitter with Spawn Rate and Lifetime curves", () => {
    const { scene } = host();
    const system = cpuSystem(scene, {
      spawn: { rate: { mode: "curve", keys: [{ t: 0, value: 120 }, { t: 1, value: 0 }] } },
      initialize: { lifetime: { mode: "curve", keys: [{ t: 0, value: 1 }, { t: 1, value: 2 }] } },
    });
    expect(system.isStarted()).toBe(true);
    step(system, 10);
    expect(system.getActiveCount()).toBeGreaterThan(0);
  });

  it("keeps Constant size and Constant or Random Range colour for each particle's whole life", () => {
    const { scene } = host();
    const constant = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 600 } },
      initialize: { ...still, size: { mode: "constant", value: 2 }, color: { mode: "constant", color: [1, 0, 0, 1] } },
    });
    const range = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 600 } },
      initialize: { ...still, color: { mode: "range", min: [1, 0, 0, 1], max: [0, 0, 1, 1] } },
    });
    step(constant, 5);
    step(range, 1);
    const born = new Map(range.particles.map((particle) => [particle, particle.color.clone()]));
    step(constant, 20);
    step(range, 20);
    expect(constant.particles.length).toBeGreaterThan(0);
    for (const particle of constant.particles) {
      expect(particle.size).toBe(2);
      expect(particle.color.equalsWithEpsilon(new Color4(1, 0, 0, 1), 1e-6)).toBe(true);
    }
    expect(born.size).toBeGreaterThan(0);
    for (const [particle, color] of born) {
      expect(particle.color.equalsWithEpsilon(color, 1e-6)).toBe(true);
      expect(particle.color.r + particle.color.b).toBeCloseTo(1);
    }
  });

  it("spawns Hemisphere particles on the upper half of the authored radius", () => {
    const { scene } = host();
    const system = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 600 } },
      shape: { kind: "hemisphere", radius: 2, radiusRange: 1, randomizer: 0 },
      initialize: still,
    });
    step(system, 10);
    const distances = system.particles.map((particle) => particle.position.length());
    expect(distances.length).toBeGreaterThan(20);
    for (const particle of system.particles) expect(particle.position.y).toBeGreaterThanOrEqual(0);
    expect(Math.max(...distances)).toBeGreaterThan(1);
    expect(Math.max(...distances)).toBeLessThanOrEqual(2 + 1e-6);
  });

  it("emits a Spawn Point Only cone from its apex and a Directed cone between its directions", () => {
    const { scene } = host();
    const apex = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 600 } },
      shape: { kind: "cone", radius: 1, angle: Math.PI / 3, emitFromSpawnPointOnly: true },
      initialize: still,
    });
    const directed = cpuSystem(scene, {
      spawn: { rate: { mode: "constant", value: 600 } },
      shape: { kind: "cone", radius: 1, direction: { mode: "directed", direction1: [1, 0, 0], direction2: [1, 0.5, 0] } },
      initialize: { speed: { mode: "constant", value: 1 } },
    });
    step(apex, 5);
    step(directed, 5);
    expect(apex.particles.length).toBeGreaterThan(0);
    for (const particle of apex.particles) expect(particle.position.length()).toBeLessThan(1e-3);
    expect(directed.particles.length).toBeGreaterThan(0);
    for (const { direction } of directed.particles) {
      expect(direction.x).toBeCloseTo(1);
      expect(direction.y).toBeGreaterThanOrEqual(0);
      expect(direction.y).toBeLessThanOrEqual(0.5);
      expect(direction.z).toBeCloseTo(0);
    }
  });

  it("waits for actual compiled particle source before creating effects", async () => {
    const { scene } = host();
    const library = new MaterialLibrary();
    const acquired = library.acquire(scene, "particle-source", createDefaultMaterialDocument("Sparks", "particle"));
    if (materialUnavailable(acquired)) throw new Error("Particle fixture must compile");
    const registered = vi.spyOn(Effect, "RegisterShader");
    const effectCreation = vi.spyOn(acquired.material, "createEffectForParticles");
    const system = createBabylonParticleSystem("compiled", scene, 16, false);
    void bindParticleMaterial(system, acquired.material);
    expect(effectCreation).not.toHaveBeenCalled();
    await acquired.ready;
    await vi.waitFor(() => expect(effectCreation).toHaveBeenCalledOnce());
    expect(registered.mock.calls.length).toBeGreaterThan(0);
    // Empty registration makes Babylon fall back to fetching a generated .fx URL.
    for (const [, source] of registered.mock.calls) expect(source).toContain("void main");
    for (const blend of [ParticleSystem.BLENDMODE_ONEONE, ParticleSystem.BLENDMODE_MULTIPLY]) {
      await vi.waitFor(() => expect(system.getCustomEffect(blend)?.fragmentSourceCode).toContain("void main"));
    }
    system.dispose();
    library.dispose();
  });

  it("does not bind an obsolete material after replacement or system disposal", async () => {
    const { scene } = host();
    const library = new MaterialLibrary();
    const first = library.acquire(scene, "first", createDefaultMaterialDocument("First", "particle"));
    const second = library.acquire(scene, "second", createDefaultMaterialDocument("Second", "particle"));
    if (materialUnavailable(first) || materialUnavailable(second)) throw new Error("Particle fixtures must compile");
    const oldEffect = vi.spyOn(first.material, "createEffectForParticles");
    const newEffect = vi.spyOn(second.material, "createEffectForParticles");
    const live = createBabylonParticleSystem("live", scene, 16, false);
    const removed = createBabylonParticleSystem("removed", scene, 16, false);
    void bindParticleMaterial(live, first.material);
    void bindParticleMaterial(live, second.material);
    void bindParticleMaterial(removed, first.material);
    removed.dispose();
    await Promise.all([first.ready, second.ready]);
    await vi.waitFor(() => expect(newEffect).toHaveBeenCalledOnce());
    expect(newEffect).toHaveBeenCalledWith(live);
    expect(oldEffect).not.toHaveBeenCalled();
    live.dispose();
    library.dispose();
  });

  it("bounds absolute lifetime gradients even when base lifetime is less than one", () => {
    const { scene } = host();
    const system = createBabylonParticleSystem("gradient", scene, 16, false);
    system.minLifeTime = 0.1;
    system.maxLifeTime = 0.2;
    system.addLifeTimeGradient(0, 1.5, 2);
    system.addLifeTimeGradient(1, 0.5);
    expect(particleLifetimeBound(system)).toBe(2);
    system.dispose();
  });

  it("removes the custom readiness check when effect preparation fails", async () => {
    const { scene } = host();
    const system = createBabylonParticleSystem("failed", scene, 16, false);
    const material = new NodeMaterial("failed material", scene);
    material.mode = NodeMaterialModes.Particle;
    material.createEffectForParticles = () => { throw new Error("controlled effect failure"); };
    const add = vi.spyOn(scene, "addIsReadyCheck");
    const remove = vi.spyOn(scene, "removeIsReadyCheck");
    await expect(bindParticleMaterial(system, material)).rejects.toThrow("controlled effect failure");
    expect(remove).toHaveBeenCalledWith(add.mock.calls[0]![0]);
    system.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
