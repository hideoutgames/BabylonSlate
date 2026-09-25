import { Mesh, MeshBuilder, NodeMaterial, NodeMaterialModes, ParticleSystem, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeParticleEmitterPayload,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
} from "@babylonslate/assets";
import { PARTICLE_CPU_CAPACITY_BUDGET, PARTICLE_UPDATE_SPEED } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { ParticleService, particleStats, type ParticleMaterialOwner, type ParticleServiceDiagnostic } from "./particle-service";
import type { ResourceLease } from "./resource-cache";

/** A Basic emitter using the "mat" Material unless the payload names another. */
function basic(payload: { render?: Record<string, unknown> } & Record<string, unknown> = {}): ParticleLibraryEmitter {
  return { kind: "basic", payload: normalizeParticleEmitterPayload({ ...payload, render: { materialGuid: "mat", ...payload.render } }) };
}

function library(emitters: Record<string, ParticleLibraryEmitter>, slots: string[] = Object.keys(emitters)): ParticleLibrary {
  return {
    emitters: new Map(Object.entries(emitters)),
    systems: new Map([["sys-1", { emitterGuids: slots, space: "world", previewSkybox: true }]]),
  };
}

/** Particle-domain stand-in: binding completes without compiling a shader. */
function particleMaterial(scene: Scene): NodeMaterial {
  const material = new NodeMaterial("particle", scene);
  material.mode = NodeMaterialModes.Particle;
  material.createEffectForParticles = () => {};
  return material;
}

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

  function host(options: {
    ready?: (guid: string) => Promise<void> | undefined;
    sceneForSlot?: (slotId: number) => Scene | null;
    statsScope?: "global" | "local";
    /** Transform-feedback caps: GPU slots are built, but NullEngine never draws them. */
    gpu?: boolean;
  } = {}) {
    const handle = createTestEngine();
    handles.push(handle);
    if (options.gpu) vi.spyOn(handle.engine, "getCaps").mockReturnValue({ ...handle.engine.getCaps(), supportTransformFeedbacks: true });
    const emitterMesh = MeshBuilder.CreateBox("emitter", { size: 0.1 }, handle.scene);
    const leases = { acquired: 0, released: 0 };
    const diagnostics: ParticleServiceDiagnostic[] = [];
    const acquireMaterial = (guid: string, owner: ParticleMaterialOwner): ResourceLease<NodeMaterial> | null => {
      if (!guid.startsWith("mat")) return null;
      const resource = particleMaterial(owner.scene);
      leases.acquired += 1;
      return { key: owner.instanceKey, resource, ready: options.ready?.(guid),
        release: () => { leases.released += 1; resource.dispose(); } };
    };
    const service = new ParticleService({
      scene: handle.scene,
      gpuSupported: options.gpu ?? false,
      acquireMaterial,
      resolveEmitter: (slotId) => (slotId === 1 ? emitterMesh : null),
      sceneForSlot: options.sceneForSlot,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      statsScope: options.statsScope,
    });
    const assign = (slotId = 1, play = true) => service.handleCommand({ type: "assignParticle", slotId, actorGuid: "fx",
      componentId: "particle-1", particleSystemGuid: "sys-1", play });
    /** One rendered frame for the service's per-frame work (NullEngine never simulates). */
    const frame = () => {
      handle.scene.onBeforeRenderObservable.notifyObservers(handle.scene);
      handle.scene.onAfterRenderObservable.notifyObservers(handle.scene);
    };
    const state = () => service.playbackState("fx", "particle-1");
    return { ...handle, service, emitterMesh, leases, diagnostics, assign, frame, state };
  }

  const started = (system: unknown) => (system as ParticleSystem | undefined)?.isStarted() === true;

  it("constructs a CPU ParticleSystem, applies billboard quads, and starts on play once its Material binds", async () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic({ emitter: { capacity: 128 } }) }));
    assign();
    expect(scene.particleSystems).toHaveLength(1);
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system).toBeInstanceOf(ParticleSystem);
    expect(system.getCapacity()).toBe(128);
    expect(system.isBillboardBased).toBe(true);
    expect(system.billboardMode).toBe(ParticleSystem.BILLBOARDMODE_ALL);
    expect(system.blendMode).toBe(ParticleSystem.BLENDMODE_ONEONE);
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    expect(service.stats()).toEqual({ systems: 1, playing: 1, gpu: false, gpuSystems: 0 });
    service.dispose();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.stats().systems).toBe(0);
  });

  it("keeps the Play emitter enabled at zero visibility", () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic() }));
    assign();
    const emitter = scene.particleSystems[0]!.emitter as Mesh;
    expect(emitter.isEnabled()).toBe(true);
    expect(emitter.isVisible).toBe(true);
    expect(emitter.visibility).toBe(0);
    expect(emitter.alwaysSelectAsActiveMesh).toBe(true);
    expect(emitter.isPickable).toBe(false);
    service.dispose();
  });

  it("caps CPU fallback capacity at 512", () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic({ emitter: { capacity: 4096 } }) }));
    assign();
    expect(scene.particleSystems[0]!.getCapacity()).toBe(PARTICLE_CPU_CAPACITY_BUDGET);
    service.dispose();
  });

  it("skips a slot without a usable Material and keeps playing the others", async () => {
    const { scene, service, diagnostics, assign } = host();
    service.setLibrary(library({
      unset: basic({ render: { materialGuid: null } }),
      missing: basic({ render: { materialGuid: "gone" } }),
      "em-1": basic(),
    }));
    expect(() => assign()).not.toThrow();
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "particle.missing_material", assetGuid: "unset", message: expect.stringMatching(/no Material/i) }),
      expect.objectContaining({ code: "particle.missing_material", assetGuid: "missing", message: expect.stringMatching(/no usable Material/i) }),
    ]);
    expect(scene.particleSystems).toHaveLength(1);
    await vi.waitFor(() => expect(started(scene.particleSystems[0])).toBe(true));
    expect(service.stats()).toMatchObject({ systems: 1, playing: 1 });
    service.dispose();
  });

  it("creates no native system when the only slot has no Material", () => {
    const { scene, service, diagnostics, assign, state } = host();
    service.setLibrary(library({ "em-1": basic({ render: { materialGuid: null } }) }));
    assign();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.stats().systems).toBe(0);
    expect(state()).toBe("failed");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["particle.missing_material"]);
    service.dispose();
  });

  it("retires only the slot whose Material fails to compile", async () => {
    const { scene, service, diagnostics, leases, assign } = host({
      ready: (guid) => guid === "mat-broken" ? Promise.reject(new Error("controlled compile failure")) : undefined,
    });
    service.setLibrary(library({ broken: basic({ render: { materialGuid: "mat-broken" } }), "em-1": basic() }));
    assign();
    await vi.waitFor(() => expect(diagnostics).toEqual([
      { code: "particle.apply_failed", assetGuid: "broken", message: "controlled compile failure" },
    ]));
    await vi.waitFor(() => expect(started(scene.particleSystems[0])).toBe(true));
    expect(scene.particleSystems).toHaveLength(1);
    expect(leases.released).toBe(1);
    expect(service.stats()).toMatchObject({ systems: 1, playing: 1 });
    service.dispose();
    expect(leases.released).toBe(leases.acquired);
  });

  it("stops with stop() and disposes on resetSession so GPU leftovers cannot linger", async () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic() }));
    assign();
    const system = scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    service.handleCommand({ type: "setParticlePlaying", actorGuid: "fx", componentId: "particle-1", playing: false });
    expect(service.stats().playing).toBe(0);
    expect(scene.particleSystems).toHaveLength(1);
    service.handleCommand({ type: "setParticlePlaying", actorGuid: "fx", playing: true });
    expect(service.stats().playing).toBe(1);
    expect(scene.particleSystems[0]).not.toBe(system);
    await vi.waitFor(() => expect(started(scene.particleSystems[0])).toBe(true));
    service.resetSession();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.stats().playing).toBe(0);
  });

  it("starts one Babylon system per Particle Emitter slot", () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic(), "em-2": basic({ render: { blendMode: "standard" } }) }));
    assign();
    expect(scene.particleSystems).toHaveLength(2);
    expect(service.stats().systems).toBe(2);
    service.dispose();
  });

  it("disposes live systems when assignParticle clears the guid", () => {
    const { scene, service, assign } = host();
    service.setLibrary(library({ "em-1": basic() }));
    assign();
    service.handleCommand({ type: "assignParticle", slotId: 1, actorGuid: "fx", componentId: "particle-1", particleSystemGuid: null });
    expect(scene.particleSystems).toHaveLength(0);
    service.dispose();
  });

  it("diagnoses unknown Particle System and Emitter assets", () => {
    const { scene, service, diagnostics } = host();
    service.setLibrary(library({}, ["missing"]));
    service.handleCommand({ type: "assignParticle", slotId: 1, actorGuid: "fx", componentId: "particle-1", particleSystemGuid: "missing-sys", play: true });
    service.handleCommand({ type: "assignParticle", slotId: 1, actorGuid: "fx", componentId: "particle-1", particleSystemGuid: "sys-1", play: true });
    expect(scene.particleSystems).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "particle.unknown_system", assetGuid: "missing-sys" }),
      expect.objectContaining({ code: "particle.unknown_emitter", assetGuid: "missing" }),
    ]);
    service.dispose();
  });

  it("assigns without starting when play is false, then parents onto bindSlot", async () => {
    const { scene, service, emitterMesh, assign } = host();
    service.setLibrary(library({ "em-1": basic() }));
    assign(2, false);
    const system = scene.particleSystems[0] as ParticleSystem;
    await Promise.resolve();
    expect(service.stats().playing).toBe(0);
    expect(system.isStarted()).toBe(false);
    service.bindSlot(2, emitterMesh);
    expect((system.emitter as { parent?: unknown }).parent).toBe(emitterMesh);
    service.dispose();
  });

  it("maps ParticleComponent sorting layer onto renderingGroupId", () => {
    const { scene, service } = host();
    service.setLibrary(library({ "em-1": basic() }));
    service.handleCommand({ type: "assignParticle", slotId: 1, actorGuid: "fx", componentId: "particle-1", particleSystemGuid: "sys-1",
      play: true, sortingLayer: "UI", orderInLayer: 3 });
    expect(scene.particleSystems[0]!.renderingGroupId).toBe(3);
    service.dispose();
  });

  it("hosts overlay-slot particles on the overlay scene, not the world scene", async () => {
    let overlay: Scene | null = null;
    const { scene, service, engine } = host({ sceneForSlot: (slotId) => (slotId === 4 ? overlay : null) });
    overlay = new Scene(engine);
    const emitterMesh = MeshBuilder.CreateBox("overlay-emitter", { size: 0.1 }, overlay);
    service.bindSlot(4, emitterMesh);
    service.setLibrary(library({ "em-1": basic() }));
    service.handleCommand({ type: "assignParticle", slotId: 4, actorGuid: "fx", componentId: "particle-1", particleSystemGuid: "sys-1", play: true });
    expect(overlay.particleSystems).toHaveLength(1);
    expect(scene.particleSystems).toHaveLength(0);
    const emitter = overlay.particleSystems[0]!.emitter as Mesh;
    expect(emitter.getScene()).toBe(overlay);
    expect(scene.getMeshByName(emitter.name)).toBeNull();
    await vi.waitFor(() => expect(started(overlay!.particleSystems[0])).toBe(true));
    service.dispose();
    overlay.dispose();
  });

  it("applies value edits in place without restarting the running system", async () => {
    const { scene, service, assign } = host();
    service.updateLibrary(library({ "em-1": basic() }));
    assign();
    const system = scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    const start = vi.spyOn(system, "start");
    const edit = service.updateLibrary(library({ "em-1": basic({ spawn: { rate: { mode: "constant", value: 45 } } }) }));
    expect(edit.tier).toBe("live");
    expect(scene.particleSystems).toEqual([system]);
    expect(system.emitRate).toBe(45);
    expect(start).not.toHaveBeenCalled();
    service.dispose();
  });

  it("keeps a paused preview frozen through live edits", async () => {
    const { scene, service, assign } = host();
    service.updateLibrary(library({ "em-1": basic() }));
    service.setPaused(true);
    assign();
    const system = scene.particleSystems[0] as ParticleSystem;
    service.updateLibrary(library({ "em-1": basic({ initialize: { speed: { mode: "constant", value: 4 } } }) }));
    expect(system.updateSpeed).toBe(0);
    service.setPaused(false);
    expect(system.updateSpeed).toBe(PARTICLE_UPDATE_SPEED);
    service.dispose();
  });

  it("re-prepares the bundle for a Capacity edit and keeps its play state", async () => {
    const { scene, service, leases, assign } = host();
    service.updateLibrary(library({ "em-1": basic() }));
    assign();
    const first = scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(first.isStarted()).toBe(true));
    expect(service.updateLibrary(library({ "em-1": basic({ emitter: { capacity: 64 } }) })).tier).toBe("rebuild");
    const rebuilt = scene.particleSystems[0] as ParticleSystem;
    expect(scene.particleSystems).toHaveLength(1);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.getCapacity()).toBe(64);
    expect(leases.released).toBe(1);
    await vi.waitFor(() => expect(rebuilt.isStarted()).toBe(true));
    service.dispose();
  });

  it("re-prepares a skipped slot once its emitter gains a Material", async () => {
    const { scene, service, assign } = host();
    service.updateLibrary(library({ "em-1": basic({ render: { materialGuid: null } }) }));
    assign();
    expect(scene.particleSystems).toHaveLength(0);
    expect(service.updateLibrary(library({ "em-1": basic({ render: { materialGuid: null } }) })).tier).toBe("none");
    expect(service.updateLibrary(library({ "em-1": basic() })).tier).toBe("rebuild");
    expect(scene.particleSystems).toHaveLength(1);
    await vi.waitFor(() => expect(started(scene.particleSystems[0])).toBe(true));
    service.dispose();
  });

  it("reports a value edit on a skipped slot as a rebuild without applying it", async () => {
    const { scene, service, assign } = host();
    const rate = { spawn: { rate: { mode: "constant", value: 45 } } };
    const skipped = { render: { materialGuid: null } };
    service.updateLibrary(library({ "em-1": basic(), skipped: basic(skipped) }));
    assign();
    const system = scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    // Only the service knows the slot was skipped, so the preview debounces this edit.
    expect(service.libraryChangeTier(library({ "em-1": basic(), skipped: basic({ ...skipped, ...rate }) }))).toBe("rebuild");
    expect(service.libraryChangeTier(library({ "em-1": basic(rate), skipped: basic(skipped) }))).toBe("live");
    expect(service.libraryChangeTier(library({ "em-1": basic(), skipped: basic(skipped) }, ["em-1"]))).toBe("rebuild");
    expect(scene.particleSystems).toEqual([system]);
    expect(system.emitRate).not.toBe(45);
    service.dispose();
  });

  it("holds a prewarming GPU emitter's bursts until its first draw", async () => {
    const { scene, service, assign, frame } = host({ gpu: true });
    service.setLibrary(library({ "em-1": basic({ emitter: { prewarm: 1 }, spawn: { rate: { mode: "constant", value: 0 },
      bursts: { enabled: true, entries: [{ time: 0, count: 8, cycles: 1, interval: 0.5 }] } } }) }));
    assign();
    const system = scene.particleSystems[0]!;
    expect(service.stats().gpuSystems).toBe(1);
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    // GPU prewarm runs inside the first ready render and would emit a queued burst there.
    frame();
    frame();
    expect(system.manualEmitCount).toBe(-1);
    system.onBeforeDrawParticlesObservable.notifyObservers(null);
    frame();
    expect(system.manualEmitCount).toBe(8);
    service.dispose();
  });

  it("drains a GPU emitter stopped while paused before it started", async () => {
    const { scene, service, assign, frame, state } = host({ gpu: true });
    service.setLibrary(library({ "em-1": basic() }));
    service.setPaused(true);
    assign();
    await vi.waitFor(() => expect(state()).toBe("playing"));
    service.handleCommand({ type: "setParticlePlaying", actorGuid: "fx", playing: false });
    // A claimed GPU ring reports full capacity and an unstarted system never draws.
    frame();
    expect(scene.particleSystems).toHaveLength(0);
    expect(state()).toBe("ready-stopped");
    service.dispose();
  });

  it("keeps preview stats out of the Play stats hook", () => {
    Object.assign(particleStats, { systems: 0, playing: 0, gpu: false, gpuSystems: 0 });
    const { service, assign } = host({ statsScope: "local" });
    service.setLibrary(library({ "em-1": basic() }));
    assign();
    expect(service.stats().systems).toBe(1);
    expect(particleStats.systems).toBe(0);
    expect(service.previewStats()).toMatchObject({ capacity: 256, backend: "cpu", approximate: false });
    service.dispose();
  });
});
