import { MeshBuilder, NodeMaterial, NodeMaterialModes, NullEngine, ParticleSystem, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeParticleEmitterPayload, type ParticleLibrary } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ParticleService } from "./particle-service";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const basic = (payload: Record<string, unknown> = {}) =>
  ({ kind: "basic" as const, payload: normalizeParticleEmitterPayload({ ...payload, render: { materialGuid: "material" } }) });

function libraryOf(emitters: Record<string, Record<string, unknown>> = { emitter: {} }): ParticleLibrary {
  return {
    emitters: new Map(Object.entries(emitters).map(([guid, payload]) => [guid, basic(payload)])),
    systems: new Map([["system", { emitterGuids: Object.keys(emitters), space: "world" as const, previewSkybox: true }]]),
  };
}

/** Material leases whose readiness the test controls; `complete()` settles every pending lease. */
function fixture(pending = false, sceneForSlot?: (slot: number) => Scene | null, upload?: Promise<void> | (() => Promise<void> | undefined)) {
  const host = createTestEngine();
  const release = vi.fn();
  let acquisitions = 0;
  const waiting: Array<() => void> = [];
  const diagnostics: Array<{ code: string }> = [];
  const service = new ParticleService({ scene: host.scene, gpuSupported: false, sceneForSlot,
    acquireMaterial: (_guid, owner) => {
      acquisitions += 1;
      const resource = new NodeMaterial("controlled particle material", owner.scene);
      resource.mode = NodeMaterialModes.Particle;
      resource.createEffectForParticles = () => {};
      const ready = upload
        ? typeof upload === "function" ? upload() : upload
        : pending ? new Promise<void>((resolve) => waiting.push(resolve)) : undefined;
      return { key: "material:1", resource, ready, release: () => { release(); resource.dispose(); } };
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  service.setLibrary(libraryOf());
  const assign = () => service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system", play: true });
  const play = (playing: boolean) => service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing });
  /** One rendered frame for the service's per-frame work (NullEngine never simulates). */
  const frame = () => { host.scene.onBeforeRenderObservable.notifyObservers(host.scene); host.scene.onAfterRenderObservable.notifyObservers(host.scene); };
  cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
  return { ...host, service, release, diagnostics, assign, play, frame,
    acquisitions: () => acquisitions,
    complete: async () => { for (const resolve of waiting.splice(0)) resolve(); await new Promise((settled) => setTimeout(settled, 0)); } };
}

/** Advance native CPU simulation by `frames` × 1/60 s (the readiness texture never readies on NullEngine). */
function simulate(systems: readonly unknown[], frames: number): void {
  for (let i = 0; i < frames; i += 1) for (const system of systems) (system as ParticleSystem).animate(true);
}

describe("particle incarnation and playback ownership", () => {
  it("cancels a delayed start on Stop and releases its lease", async () => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(old, "start");
    f.play(false);
    await f.complete();
    expect(start).not.toHaveBeenCalled();
    expect(f.service.stats().playing).toBe(0);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("makes callbacks from a replaced same-key component inert", async () => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const oldStart = vi.spyOn(old, "start");
    f.assign();
    const replacement = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(replacement, "start");
    await f.complete();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(oldStart).not.toHaveBeenCalled();
    expect(f.scene.particleSystems).toEqual([replacement]);
  });

  it("coalesces pending Play and leaves an already playing system untouched", async () => {
    const f = fixture(true);
    f.assign();
    const native = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(native, "start");
    const reset = vi.spyOn(native, "reset");
    for (let i = 0; i < 100; i += 1) f.play(true);
    await f.complete();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 100; i += 1) f.play(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("keeps a synchronous start observer's Stop as the desired state", async () => {
    const f = fixture(true);
    f.assign();
    const observed = vi.fn(() => {
      expect(f.service.stats().playing).toBe(1);
      f.play(false);
    });
    f.scene.particleSystems[0]!.onStartedObservable.addOnce(observed);
    await f.complete();
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
    expect(f.service.stats().playing).toBe(0);
  });

  it("keeps assignments and restarted runs frozen when prepared while paused", async () => {
    const f = fixture();
    f.service.setPaused(true);
    f.assign();
    const first = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(first.isStarted()).toBe(true));
    const advance = (system: ParticleSystem) => {
      system.emitRate = 100;
      // Public prewarm stepping uses the same native CPU simulation without a GPU draw.
      for (let i = 0; i < 10; i += 1) system.animate(true);
    };
    advance(first);
    expect(first.getActiveCount()).toBe(0);
    f.service.setPaused(false);
    const preparedSpeed = first.updateSpeed;
    advance(first);
    expect(first.getActiveCount()).toBeGreaterThan(0);
    f.service.setPaused(true);
    f.play(false);
    f.play(true);
    const restarted = f.scene.particleSystems[0] as ParticleSystem;
    expect(restarted).not.toBe(first);
    await vi.waitFor(() => expect(restarted.isStarted()).toBe(true));
    advance(restarted);
    expect(restarted.getActiveCount()).toBe(0);
    f.service.setPaused(false);
    expect(restarted.updateSpeed).toBe(preparedSpeed);
    advance(restarted);
    expect(restarted.getActiveCount()).toBeGreaterThan(0);
  });

  it("ignores an old Material rejection after a same-key successor starts", async () => {
    let reject!: (error: unknown) => void;
    const firstUpload = new Promise<void>((_resolve, fail) => { reject = fail; });
    let acquisitions = 0;
    const f = fixture(false, undefined, () => ++acquisitions === 1 ? firstUpload : undefined);
    f.assign();
    f.assign();
    const successor = f.scene.particleSystems[0]!;
    await vi.waitFor(() => expect(successor.isStarted()).toBe(true));
    reject(new Error("late old generation failure"));
    await Promise.resolve();
    expect(f.scene.particleSystems).toEqual([successor]);
    expect(f.diagnostics).toEqual([]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable SceneLayer assignment pending in its intended owner", () => {
    const f = fixture(false, () => null);
    f.assign();
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.scene.meshes.filter((mesh) => mesh.name.startsWith("particleEmitter:"))).toHaveLength(0);
  });

  it("selects GPU support from the owning engine even when another engine was created last", () => {
    const first = createTestEngine();
    const caps = first.engine.getCaps();
    vi.spyOn(first.engine, "getCaps").mockReturnValue({ ...caps, supportTransformFeedbacks: true });
    const second = new NullEngine();
    const service = new ParticleService({ scene: first.scene });
    cleanups.push(() => { service.dispose(); second.dispose(); first.scene.dispose(); first.engine.dispose(); });
    expect(service.stats().gpu).toBe(true);
  });

  it.each(["despawn", "reset", "layer-remove", "scene-dispose", "dispose"] as const)("cancels pending starts on %s", async (boundary) => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(old, "start");
    if (boundary === "despawn") f.service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "actor" });
    else if (boundary === "reset") f.service.resetSession();
    else if (boundary === "layer-remove") f.service.retireSlots((slot) => slot === 1);
    else if (boundary === "scene-dispose") f.scene.dispose();
    else f.service.dispose();
    await f.complete();
    expect(start).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.service.stats().systems).toBe(0);
  });

  it("releases failed Material preparations and removes their custom scene-readiness checks", async () => {
    let reject!: (error: unknown) => void;
    const upload = new Promise<void>((_resolve, fail) => { reject = fail; });
    const f = fixture(false, undefined, upload);
    const add = vi.spyOn(f.scene, "addIsReadyCheck");
    const remove = vi.spyOn(f.scene, "removeIsReadyCheck");
    f.assign();
    reject(new Error("controlled compile failure"));
    await vi.waitFor(() => expect(f.diagnostics).toEqual([{ code: "particle.apply_failed", message: "controlled compile failure", assetGuid: "emitter" }]));
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map(([check]) => check)).toEqual(add.mock.calls.map(([check]) => check));
    expect(f.service.stats().systems).toBe(0);
  });

  it("creates a missing owner when available and rebuilds instead of reparenting across scenes", () => {
    let intended: Scene | null = null;
    const f = fixture(false, () => intended);
    f.assign();
    const overlay = new Scene(f.engine);
    const parent = MeshBuilder.CreateBox("overlay-parent", {}, overlay);
    cleanups.push(() => overlay.dispose());
    intended = overlay;
    f.service.bindSlot(1, parent);
    const first = overlay.particleSystems[0]!;
    expect(first.emitter).toMatchObject({ parent });
    expect(first.getScene()).toBe(overlay);
    intended = f.scene;
    f.service.bindSlot(1, null);
    expect(overlay.particleSystems).toHaveLength(0);
    expect(f.scene.particleSystems).toHaveLength(1);
    expect(f.scene.particleSystems[0]).not.toBe(first);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("returns native systems, readiness textures, emitter geometry, observers and leases to the warmed baseline", async () => {
    const f = fixture();
    const before = { meshes: f.scene.meshes.length, geometry: f.scene.geometries.length, textures: f.scene.textures.length,
      before: f.scene.onBeforeRenderObservable.observers.length, after: f.scene.onAfterRenderObservable.observers.length };
    for (let i = 0; i < 200; i += 1) { f.assign(); f.service.resetSession(); }
    await vi.waitFor(() => expect(f.scene.onBeforeRenderObservable.observers.length).toBe(before.before));
    expect(f.scene.onAfterRenderObservable.observers.length).toBe(before.after);
    expect(f.scene.meshes).toHaveLength(before.meshes);
    expect(f.scene.geometries).toHaveLength(before.geometry);
    expect(f.scene.textures).toHaveLength(before.textures);
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.acquisitions()).toBe(200);
    expect(f.release).toHaveBeenCalledTimes(200);
  });
});

describe("per-emitter lifecycle", () => {
  it("keeps the bundle playing while a looping slot runs after a Once slot finishes", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ flash: { emitter: { loop: "once", duration: 0.25 } }, smoke: {} }));
    f.assign();
    const [flash, smoke] = f.scene.particleSystems as ParticleSystem[];
    const flashStopped = vi.fn();
    const smokeStopped = vi.fn();
    flash!.onStoppedObservable.add(flashStopped);
    smoke!.onStoppedObservable.add(smokeStopped);
    await vi.waitFor(() => expect(smoke!.isStarted()).toBe(true));
    simulate([flash, smoke], 20);
    f.frame();
    expect(flashStopped).toHaveBeenCalledOnce();
    expect(smokeStopped).not.toHaveBeenCalled();
    expect(f.service.stats()).toMatchObject({ systems: 2, playing: 1 });
  });

  it("queues bursts after a rendered frame, restores rate emission, and keeps a drain muted", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ burst: { spawn: { rate: { mode: "constant", value: 0 },
      bursts: { enabled: true, entries: [{ time: 0, count: 8, cycles: 1, interval: 0.5 }] } } } }));
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    f.frame();
    expect(system.manualEmitCount).toBe(8);
    simulate([system], 1);
    expect(system.getActiveCount()).toBe(8);
    f.frame();
    expect(system.manualEmitCount).toBe(-1);
    f.play(false);
    f.frame();
    f.frame();
    expect(system.manualEmitCount).toBe(0);
    expect(f.service.stats()).toMatchObject({ systems: 1, playing: 0 });
  });

  it("drains a System whose Once slots have all finished", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({
      short: { emitter: { loop: "once", duration: 0.25 } },
      long: { emitter: { loop: "once", duration: 0.5 } },
    }));
    f.assign();
    const systems = [...f.scene.particleSystems] as ParticleSystem[];
    await vi.waitFor(() => expect(systems.every((system) => system.isStarted())).toBe(true));
    simulate(systems, 20);
    f.frame();
    expect(f.service.stats().playing).toBe(1);
    // Past the longer Duration plus the 1.2 s lifetime bound, every particle has died.
    simulate(systems, 120);
    f.frame();
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.service.stats()).toMatchObject({ systems: 0, playing: 0 });
  });
});
