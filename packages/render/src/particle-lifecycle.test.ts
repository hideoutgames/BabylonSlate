import { MeshBuilder, NodeMaterial, NodeMaterialModes, NullEngine, ParticleSystem, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeParticleEmitterPayload, type ParticleLibrary, type ParticleLibraryEmitter } from "@haptic/assets";
import { createDefaultParticleGraphDocument, type ParticleGraphDocument } from "@haptic/particle-graph";
import { PARTICLE_UPDATE_SPEED } from "@haptic/core";
import { createTestEngine } from "./create-null-engine";
import { ParticleService, type ParticlePlaybackEndedReport } from "./particle-service";

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

/** The default Particle Graph with a Material, edited by `edit`. */
function graphLibrary(edit?: (document: ParticleGraphDocument) => void): ParticleLibrary {
  const document = createDefaultParticleGraphDocument();
  document.materialGuid = "material";
  edit?.(document);
  const emitter: ParticleLibraryEmitter = { kind: "graph", document };
  return {
    emitters: new Map([["graph", emitter]]),
    systems: new Map([["system", { emitterGuids: ["graph"], space: "world" as const, previewSkybox: true }]]),
  };
}

/** Material leases whose readiness the test controls; `complete()` settles every pending lease. */
function fixture(pending = false, sceneForSlot?: (slot: number) => Scene | null, upload?: Promise<void> | (() => Promise<void> | undefined),
  statsScope: "global" | "local" = "global") {
  const host = createTestEngine();
  const release = vi.fn();
  let acquisitions = 0;
  const waiting: Array<() => void> = [];
  const diagnostics: Array<{ code: string }> = [];
  const ended: ParticlePlaybackEndedReport[] = [];
  const service = new ParticleService({ scene: host.scene, gpuSupported: false, sceneForSlot, statsScope,
    onPlaybackEnded: (report) => ended.push(report),
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
  const state = () => service.playbackState("actor", "particle");
  cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
  return { ...host, service, release, diagnostics, ended, assign, play, frame, state,
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
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
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
    // The drained-out first run overlaps as a ghost; the new run is the last system.
    const restarted = f.scene.particleSystems.at(-1) as ParticleSystem;
    expect(restarted).not.toBe(first);
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    advance(restarted);
    expect(restarted.getActiveCount()).toBe(0);
    f.service.setPaused(false);
    expect(restarted.updateSpeed).toBe(preparedSpeed);
    advance(restarted);
    expect(restarted.getActiveCount()).toBeGreaterThan(0);
  });

  it("keeps Pre Warm for a run prepared while paused", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ warm: { emitter: { prewarm: 1 }, spawn: { rate: { mode: "constant", value: 60 } },
      initialize: { lifetime: { mode: "constant", value: 2 } } } }));
    f.service.setPaused(true);
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    f.service.setPaused(false);
    // CPU prewarm runs inside start(): one second at 60 /s is in place before any frame.
    expect(system.getActiveCount()).toBeGreaterThan(50);
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
    // Released, not failed: the next Play prepares a new run.
    expect(f.state()).toBe("ready-stopped");
  });

  it("needs Scene frames while a run prepares, emits or drains, and not while paused or finished", async () => {
    const f = fixture(true);
    f.service.setLibrary(libraryOf({ flash: { emitter: { loop: "once", duration: 0.25 } } }));
    expect(f.service.needsFrames()).toBe(false);
    f.assign();
    expect(f.state()).toBe("preparing");
    expect(f.service.needsFrames()).toBe(true);

    await f.complete();
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    // A freshly started emitter has no particles yet, but it still needs the render that creates them.
    expect(system.getActiveCount()).toBe(0);
    expect(f.service.needsFrames()).toBe(true);

    f.service.setPaused(true);
    expect(f.service.needsFrames()).toBe(false);
    f.service.setPaused(false);
    expect(f.service.needsFrames()).toBe(true);

    simulate([system], 150);
    f.frame();
    expect(f.state()).toBe("ready-stopped");
    expect(f.service.needsFrames()).toBe(false);
  });
});

describe("Particle Graph slot lifecycle", () => {
  it("never starts a graph slot whose Material readies after Stop", async () => {
    const f = fixture(true);
    f.service.setLibrary(graphLibrary());
    f.assign();
    const native = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(native, "start");
    f.play(false);
    expect(f.scene.particleSystems).toHaveLength(0);
    await f.complete();
    expect(start).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.service.stats()).toMatchObject({ systems: 0, graphSystems: 0 });
  });

  it("returns graph systems, their readiness textures, observers and leases to the baseline over 100 cycles", async () => {
    const f = fixture();
    f.service.setLibrary(graphLibrary());
    const before = { meshes: f.scene.meshes.length, textures: f.scene.textures.length, systems: f.scene.particleSystems.length,
      before: f.scene.onBeforeRenderObservable.observers.length, after: f.scene.onAfterRenderObservable.observers.length };
    for (let i = 0; i < 100; i += 1) {
      f.assign();
      expect(f.service.stats().graphSystems).toBe(1);
      f.service.resetSession();
    }
    await vi.waitFor(() => expect(f.scene.onBeforeRenderObservable.observers.length).toBe(before.before));
    expect(f.scene.onAfterRenderObservable.observers.length).toBe(before.after);
    expect(f.scene.meshes).toHaveLength(before.meshes);
    expect(f.scene.textures).toHaveLength(before.textures);
    expect(f.scene.particleSystems).toHaveLength(before.systems);
    expect(f.acquisitions()).toBe(100);
    expect(f.release).toHaveBeenCalledTimes(100);
  });

  it("drains a finished Once graph slot to its last live particle, then releases it", async () => {
    const f = fixture();
    f.service.setLibrary(graphLibrary((document) => {
      document.settings = { ...document.settings, loop: "once", duration: 0.25 };
      document.nodes = document.nodes.map((entry) => entry.id === "create" ? { ...entry, properties: { ...entry.properties, "default:lifetime": [0.5] } } : entry);
    }));
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], 20);
    f.frame();
    // Stopped natively at 0.25 s, with particles still alive: the bundle is draining.
    expect(f.state()).toBe("draining");
    expect(f.scene.particleSystems).toEqual([system]);
    simulate([system], 40);
    f.frame();
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.state()).toBe("ready-stopped");
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});

describe("playback ended reports", () => {
  const assign = (generation: number, particleSystemGuid = "system") => ({ type: "assignParticle" as const, actorGuid: "actor",
    componentId: "particle", slotId: 1, particleSystemGuid, play: true, generation });
  const play = (playing: boolean, generation?: number) => ({ type: "setParticlePlaying" as const, actorGuid: "actor",
    componentId: "particle", playing, ...(generation !== undefined ? { generation } : {}) });
  const report = (generation: number, reason: ParticlePlaybackEndedReport["reason"]) =>
    ({ actorGuid: "actor", componentId: "particle", generation, reason });

  it("reports a finished Once system once, after its drain, with the generation of its Play", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ flash: { emitter: { loop: "once", duration: 0.25 } } }));
    f.service.handleCommand(assign(7));
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], 20);
    f.frame();
    expect(f.state()).toBe("draining");
    expect(f.ended).toEqual([]);
    simulate([system], 120);
    f.frame();
    f.frame();
    expect(f.state()).toBe("ready-stopped");
    expect(f.ended).toEqual([report(7, "finished")]);

    // Play again: the next finish reports the new generation.
    f.service.handleCommand(play(true, 8));
    const replay = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(replay.isStarted()).toBe(true));
    simulate([replay], 150);
    f.frame();
    expect(f.ended).toEqual([report(7, "finished"), report(8, "finished")]);
  });

  it("reports Stop as stopped once the drain ends, with the latest Play's generation", async () => {
    const f = fixture();
    f.service.handleCommand(assign(1));
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    // Play while playing changes nothing native but names the generation the end reports.
    f.service.handleCommand(play(true, 2));
    simulate([system], 10);
    f.service.handleCommand(play(false));
    f.frame();
    expect(f.state()).toBe("draining");
    expect(f.ended).toEqual([]);
    simulate([system], 120);
    f.frame();
    expect(f.ended).toEqual([report(2, "stopped")]);
  });

  it("reports Stop before preparation finished as stopped, and a bundle with no playable slot as failed", async () => {
    const pending = fixture(true);
    pending.service.handleCommand(assign(3));
    pending.service.handleCommand(play(false));
    expect(pending.ended).toEqual([report(3, "stopped")]);
    // A second Stop on a stopped component reports nothing.
    pending.service.handleCommand(play(false));
    expect(pending.ended).toHaveLength(1);

    const empty = fixture();
    empty.service.setLibrary({ emitters: new Map(), systems: new Map([["system", { emitterGuids: ["missing"], space: "world", previewSkybox: true }]]) });
    empty.service.handleCommand(assign(4));
    expect(empty.state()).toBe("failed");
    // An unknown Particle System never gets an entry but still ends the Play.
    empty.service.handleCommand({ ...assign(5, "unknown"), componentId: "other" });
    expect(empty.ended).toEqual([report(4, "failed"), { ...report(5, "failed"), componentId: "other" }]);
    // Stop on the failed bundle does not report again.
    empty.service.handleCommand(play(false));
    expect(empty.ended).toHaveLength(2);
  });

  it("never reports for previews, Play's load warm-up, retire or despawn", async () => {
    const preview = fixture(false, undefined, undefined, "local");
    preview.service.setLibrary(libraryOf({ flash: { emitter: { loop: "once", duration: 0.25 } } }));
    preview.service.handleCommand(assign(1));
    const system = preview.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], 150);
    preview.frame();
    expect(preview.state()).toBe("ready-stopped");
    expect(preview.ended).toEqual([]);

    const play = fixture();
    // A spawnable System without a playable slot fails at the load, silently.
    play.service.setLibrary({ emitters: new Map(), systems: new Map([["system", { emitterGuids: ["missing"], space: "world", previewSkybox: true }]]) });
    play.service.prepareSpawnableSystems();
    play.service.releaseSpawnableSystems();
    play.service.setLibrary(libraryOf());
    play.service.handleCommand(assign(2));
    play.service.handleCommand({ ...assign(3), particleSystemGuid: null });
    play.service.handleCommand(assign(4));
    play.service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "actor" });
    play.service.handleCommand(assign(5));
    play.service.resetSession();
    expect(play.ended).toEqual([]);
  });
});

describe("simulation time scale", () => {
  const once = (duration: number) => libraryOf({ flash: { emitter: { loop: "once", duration }, spawn: { rate: { mode: "constant", value: 30 } },
    initialize: { lifetime: { mode: "constant", value: 0.1 } } } });

  it.each([[1, 120], [0.5, 240]] as const)("at %s finishes a 2 s Once System after %i frames", async (scale, frames) => {
    const f = fixture();
    f.service.setLibrary(once(2));
    f.service.handleCommand({ type: "setSimulationTimeScale", scale });
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], frames - 2);
    f.frame();
    expect(f.state()).toBe("playing");
    simulate([system], 4);
    f.frame();
    expect(f.state()).toBe("draining");
  });

  it("keeps a burst schedule's relative timing on the scaled clock", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ burst: { spawn: { rate: { mode: "constant", value: 0 },
      bursts: { enabled: true, entries: [{ time: 0.5, count: 8, cycles: 1, interval: 1 }] } } } }));
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0.5 });
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    // Each rendered frame advances the emission clock by half of 1/60 s: the 0.5 s burst waits 60 frames.
    for (let frame = 0; frame < 59; frame += 1) f.frame();
    expect(system.manualEmitCount).toBe(-1);
    f.frame();
    f.frame();
    expect(system.manualEmitCount).toBe(8);
  });

  it("holds systems at scale 0 like pause, without pausing, and restores the authored speed", async () => {
    const f = fixture();
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    const authored = system.updateSpeed;
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0 });
    expect(system.updateSpeed).toBe(0);
    expect(system.paused).toBe(true);
    expect(f.service.needsFrames()).toBe(false);
    // Pause and unpause while at scale 0 keeps the systems held.
    f.service.setPaused(true);
    f.service.setPaused(false);
    expect(system.paused).toBe(true);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 2 });
    expect(system.paused).toBe(false);
    expect(system.updateSpeed).toBeCloseTo(authored * 2, 12);
    // A scale set while paused applies on resume.
    f.service.setPaused(true);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0.5 });
    expect(system.updateSpeed).toBe(0);
    f.service.setPaused(false);
    expect(system.updateSpeed).toBeCloseTo(authored * 0.5, 12);
  });

  it("starts a run prepared at scale 0 when time resumes, with its full Pre Warm", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ warm: { emitter: { prewarm: 1 }, spawn: { rate: { mode: "constant", value: 60 } },
      initialize: { lifetime: { mode: "constant", value: 2 } } } }));
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0 });
    f.assign();
    const system = f.scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    expect(system.isStarted()).toBe(false);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0.25 });
    expect(system.isStarted()).toBe(true);
    // One authored second at 60 /s, not a quarter of it.
    expect(system.getActiveCount()).toBeGreaterThan(50);
    expect(system.updateSpeed).toBeCloseTo(PARTICLE_UPDATE_SPEED * 0.25, 12);
  });

  it.each([["input.system.time", 0.5], ["input.system.deltaTime", 1 / 120]] as const)(
    "slows a Particle Graph's %s with the scale", async (source, expected) => {
      const f = fixture();
      // Update Size reads the system value, spliced into the default graph's spine.
      f.service.setLibrary(graphLibrary((document) => {
        document.nodes.push(
          { id: "clock", type: source, position: { x: 0, y: 0 }, properties: {} },
          { id: "size", type: "update.size", position: { x: 0, y: 0 }, properties: {} },
        );
        document.edges = document.edges.filter((edge) => edge.id !== "e-velocity-color");
        document.edges.push(
          { id: "e-velocity-size", sourceNodeId: "velocity", sourcePinId: "out", targetNodeId: "size", targetPinId: "particle" },
          { id: "e-size-color", sourceNodeId: "size", sourcePinId: "out", targetNodeId: "updateColor", targetPinId: "particle" },
          { id: "e-clock-size", sourceNodeId: "clock", sourcePinId: "out", targetNodeId: "size", targetPinId: "size" },
        );
      }));
      f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0.5 });
      f.assign();
      const system = f.scene.particleSystems[0] as ParticleSystem;
      await vi.waitFor(() => expect(system.isStarted()).toBe(true));
      simulate([system], 60);
      // 60 frames at half speed: half a second of Time, 1/120 s of Delta Time per frame.
      expect(system.particles.length).toBeGreaterThan(0);
      expect(system.particles[0]!.size).toBeCloseTo(expected, 3);
    });
});

describe("retrigger", () => {
  const assign = (retrigger?: "overlap" | "restart") => ({ type: "assignParticle" as const, actorGuid: "actor", componentId: "particle",
    slotId: 1, particleSystemGuid: "system", play: true, generation: 1, ...(retrigger ? { retrigger } : {}) });
  let generation = 1;
  const play = (restart = false) => ({ type: "setParticlePlaying" as const, actorGuid: "actor", componentId: "particle", playing: true,
    generation: ++generation, ...(restart ? { restart: true } : {}) });
  /** A one-shot that emits for 2 s; its particles live 2 s. */
  const oneShot = () => libraryOf({ flash: { emitter: { loop: "once", duration: 2 }, spawn: { rate: { mode: "constant", value: 30 } },
    initialize: { lifetime: { mode: "constant", value: 2 } } } });
  const startedSystem = async (f: ReturnType<typeof fixture>) => {
    const system = f.scene.particleSystems.at(-1) as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], 10);
    return system;
  };

  it("runs a ghost at the session time scale and holds it at scale 0", async () => {
    const f = fixture();
    f.service.setLibrary(oneShot());
    f.service.handleCommand(assign());
    const first = await startedSystem(f);
    const authored = first.updateSpeed;
    f.service.handleCommand(play());
    const second = await startedSystem(f);
    expect(f.scene.particleSystems).toEqual([first, second]);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0.5 });
    for (const system of [first, second]) expect(system.updateSpeed).toBeCloseTo(authored * 0.5, 12);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 0 });
    expect(first.updateSpeed).toBe(0);
    expect(first.paused).toBe(true);
    f.service.handleCommand({ type: "setSimulationTimeScale", scale: 1 });
    expect(first.updateSpeed).toBeCloseTo(authored, 12);
    expect(first.paused).toBe(false);
  });

  it("keeps earlier one-shot runs on screen as ghosts on rapid Play, up to three, and cuts the oldest", async () => {
    const f = fixture();
    f.service.setLibrary(oneShot());
    f.service.handleCommand(assign());
    const runs = [await startedSystem(f)];
    for (let i = 0; i < 5; i += 1) {
      f.service.handleCommand(play());
      runs.push(await startedSystem(f));
    }
    // The current run plus the three newest ghosts; each ghost stopped emitting but keeps its particles.
    const kept = runs.slice(-4);
    expect(f.scene.particleSystems).toEqual(kept);
    for (const ghost of kept.slice(0, 3)) {
      expect((ghost as unknown as { _stopped: boolean })._stopped).toBe(true);
      expect(ghost.getActiveCount()).toBeGreaterThan(0);
    }
    expect((kept[3] as unknown as { _stopped: boolean })._stopped).toBe(false);
    expect(runs.slice(0, 2).every((cut) => !f.scene.particleSystems.includes(cut))).toBe(true);
    expect(f.service.stats()).toMatchObject({ systems: 4, playing: 1 });
    expect(f.state()).toBe("playing");
    // A ghost drains on its own and never reports; only the current run's end does.
    simulate(kept.slice(0, 3), 150);
    f.frame();
    expect(f.scene.particleSystems).toEqual([kept[3]]);
    expect(f.service.stats().systems).toBe(1);
    expect(f.ended).toEqual([]);
    // Pause holds ghosts too, and retire takes them with the bundle.
    f.service.handleCommand(play());
    const ghost = runs.at(-1)!;
    await startedSystem(f);
    f.service.setPaused(true);
    expect([ghost.updateSpeed, ghost.paused]).toEqual([0, true]);
    f.service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: null });
    expect(f.scene.particleSystems).toEqual([]);
    expect(f.service.stats().systems).toBe(0);
  });

  it("leaves a looping run playing on Play, and overlaps a run that is draining", async () => {
    const f = fixture();
    f.service.handleCommand(assign());
    const looping = await startedSystem(f);
    f.service.handleCommand(play());
    expect(f.scene.particleSystems).toEqual([looping]);
    expect(looping.isStarted()).toBe(true);
    f.service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing: false });
    expect(f.state()).toBe("draining");
    f.service.handleCommand(play());
    const next = await startedSystem(f);
    expect(f.scene.particleSystems).toEqual([looping, next]);
    expect(f.service.stats().systems).toBe(2);
  });

  it("cuts what is on screen and starts again in Restart mode", async () => {
    const f = fixture();
    f.service.setLibrary(oneShot());
    f.service.handleCommand(assign("restart"));
    const first = await startedSystem(f);
    f.service.handleCommand(play());
    const second = await startedSystem(f);
    expect(f.scene.particleSystems).toEqual([second]);
    expect(first.getActiveCount()).toBe(0);
    // While it drains, Play cuts it too.
    f.service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing: false });
    f.service.handleCommand(play());
    const third = await startedSystem(f);
    expect(f.scene.particleSystems).toEqual([third]);
    expect(f.service.stats().systems).toBe(1);
  });

  it("restarts a looping run that is already playing, and cuts its ghosts, for Restart Particles", async () => {
    const f = fixture();
    f.service.setLibrary(libraryOf({ flash: { emitter: { loop: "once", duration: 2 } }, smoke: {} }));
    f.service.handleCommand(assign());
    const [flash, smoke] = f.scene.particleSystems as ParticleSystem[];
    await vi.waitFor(() => expect(smoke!.isStarted()).toBe(true));
    // A mixed bundle loops: Play keeps it.
    f.service.handleCommand(play());
    expect(f.scene.particleSystems).toEqual([flash, smoke]);
    f.service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing: false });
    f.service.handleCommand(play());
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    expect(f.scene.particleSystems).toHaveLength(4);
    f.service.handleCommand(play(true));
    await vi.waitFor(() => expect(f.state()).toBe("playing"));
    const restarted = [...f.scene.particleSystems] as ParticleSystem[];
    expect(restarted).toHaveLength(2);
    expect(restarted.some((system) => system === flash || system === smoke)).toBe(false);
    await vi.waitFor(() => expect(restarted.every((system) => system.isStarted())).toBe(true));
  });
});

describe("Noise Textures", () => {
  function noiseService(acquireTexture?: (guid: string) => { resource: unknown; key: string; ready?: Promise<void>; release(): void } | null) {
    const host = createTestEngine();
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      acquireMaterial: (_guid, owner) => {
        const resource = new NodeMaterial("noise test material", owner.scene);
        resource.mode = NodeMaterialModes.Particle;
        resource.createEffectForParticles = () => {};
        return { key: "material:1", resource, release: () => resource.dispose() };
      },
      ...(acquireTexture ? { acquireTexture: acquireTexture as never } : {}),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary(graphLibrary((document) => {
      document.nodes.push({ id: "noise", type: "update.noise", position: { x: 0, y: 0 }, properties: { textureGuid: "tex" } });
      document.edges = document.edges.filter((edge) => edge.id !== "e-velocity-color");
      document.edges.push(
        { id: "e-velocity-noise", sourceNodeId: "velocity", sourcePinId: "out", targetNodeId: "noise", targetPinId: "particle" },
        { id: "e-noise-color", sourceNodeId: "noise", sourcePinId: "out", targetNodeId: "updateColor", targetPinId: "particle" },
      );
    }));
    service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system", play: true });
    return { service, diagnostics, scene: host.scene };
  }

  it("falls back to the built-in noise with a warning when the Texture cannot be acquired", () => {
    const { diagnostics } = noiseService();
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "particle.noise_texture_unavailable", assetGuid: "tex" }));
  });

  it("reads a Texture back once, after it is ready, and releases it", async () => {
    const release = vi.fn();
    const readPixels = vi.fn(async () => new Uint8Array(4 * 4 * 4).fill(255));
    const acquire = vi.fn(() => ({ key: "texture:tex", resource: { readPixels, getSize: () => ({ width: 4, height: 4 }) },
      ready: Promise.resolve(), release }));
    const { diagnostics } = noiseService(acquire);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(readPixels).toHaveBeenCalledTimes(1);
    expect(diagnostics.filter((entry) => entry.code === "particle.noise_texture_unavailable")).toEqual([]);
  });
});

describe("Mesh Shapes", () => {
  type Geometry = { positions: number[]; indices: number[] };
  function meshService(properties: Record<string, unknown>, options: {
    acquireModelGeometry?: (guid: string) => Promise<Geometry | null> | null;
    owner?: boolean;
  } = {}) {
    const host = createTestEngine();
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    // The owning actor: a 20 m box, so particles born on it are far from the emitter.
    const owner = options.owner ? MeshBuilder.CreateBox("owner", { size: 20 }, host.scene) : null;
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      acquireMaterial: (_guid, lease) => {
        const resource = new NodeMaterial("mesh shape test material", lease.scene);
        resource.mode = NodeMaterialModes.Particle;
        resource.createEffectForParticles = () => {};
        return { key: "material:1", resource, release: () => resource.dispose() };
      },
      ...(options.acquireModelGeometry ? { acquireModelGeometry: options.acquireModelGeometry } : {}),
      ...(owner ? { resolveEmitter: () => owner } : {}),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary(graphLibrary((document) => {
      const shape = document.nodes.find((node) => node.id === "shape")!;
      shape.type = "shape.mesh";
      shape.properties = { source: "ownerMesh", modelGuid: null, useMeshNormals: true, useMeshColor: false, ...properties };
    }));
    service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system", play: true });
    return { diagnostics, scene: host.scene };
  }
  /** Simulates a second and returns how far from the emitter the youngest particles are. */
  async function spawnDistances(scene: Scene): Promise<number[]> {
    const system = scene.particleSystems[0] as ParticleSystem;
    await vi.waitFor(() => expect(system.isStarted()).toBe(true));
    simulate([system], 60);
    return system.particles.filter((particle) => particle.age < 0.1).map((particle) => particle.position.length());
  }

  it("reports a Model it cannot load, once, and spawns at the emitter", async () => {
    const unavailable = meshService({ source: "model", modelGuid: "model-1" });
    expect(unavailable.diagnostics).toContainEqual(expect.objectContaining({ code: "particle.mesh_missing", assetGuid: "model-1" }));
    const empty = meshService({ source: "model", modelGuid: "model-2" }, { acquireModelGeometry: async () => null });
    const distances = await spawnDistances(empty.scene);
    expect(empty.diagnostics.filter((entry) => entry.code === "particle.mesh_missing")).toEqual([
      expect.objectContaining({ assetGuid: "model-2" }),
    ]);
    expect(distances.length).toBeGreaterThan(0);
    for (const distance of distances) expect(distance).toBeLessThan(2);
  });

  it("loads a Model's triangles once and spawns on them", async () => {
    // One triangle 10 m above the emitter.
    const acquire = vi.fn(async () => ({ positions: [0, 10, 0, 1, 10, 0, 0, 10, 1], indices: [0, 1, 2] }));
    const { scene, diagnostics } = meshService({ source: "model", modelGuid: "model-1" }, { acquireModelGeometry: acquire });
    const distances = await spawnDistances(scene);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith("model-1");
    expect(distances.length).toBeGreaterThan(0);
    for (const distance of distances) expect(distance).toBeGreaterThan(8);
    expect(diagnostics.filter((entry) => entry.code === "particle.mesh_missing")).toEqual([]);
  });

  it("spawns on the owning actor's mesh", async () => {
    const { scene } = meshService({}, { owner: true });
    const distances = await spawnDistances(scene);
    expect(distances.length).toBeGreaterThan(0);
    // On the box's faces, 10 m from its centre or more.
    for (const distance of distances) expect(distance).toBeGreaterThan(8);
  });
});
