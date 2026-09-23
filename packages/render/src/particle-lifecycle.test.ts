import { MeshBuilder, NullEngine, ParticleSystem, RawTexture, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ParticleService } from "./particle-service";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function fixture(pending = false, sceneForSlot?: (slot: number) => Scene | null, upload?: Promise<void> | (() => Promise<void> | undefined)) {
  const host = createTestEngine();
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, host.scene);
  let ready = !pending;
  Object.defineProperty(texture, "url", { get: () => "blob:controlled-particle-texture" });
  texture.isReady = () => ready;
  const release = vi.fn();
  const diagnostics: Array<{ code: string }> = [];
  const service = new ParticleService({ scene: host.scene, gpuSupported: false, sceneForSlot,
    acquireTexture: () => ({ key: "texture:1", resource: texture, release, ready: typeof upload === "function" ? upload() : upload }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  service.setLibrary({
    emitters: new Map([["emitter", { ...createDefaultParticleEmitterPayload(), textureGuid: "texture" }]]),
    systems: new Map([["system", { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] }]]),
  });
  const assign = () => service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system", play: true });
  const play = (playing: boolean) => service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing });
  cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
  return { ...host, service, texture, release, diagnostics, assign, play, complete: () => { ready = true; texture.onLoadObservable.notifyObservers(texture); } };
}

describe("particle incarnation and playback ownership", () => {
  it("cancels a delayed start on Stop and releases its observer and lease", () => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(old, "start");
    f.play(false);
    f.complete();
    expect(start).not.toHaveBeenCalled();
    expect(f.service.stats().playing).toBe(0);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.texture.onLoadObservable.hasObservers()).toBe(false);
  });

  it("makes callbacks from a replaced same-key component inert", () => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const oldStart = vi.spyOn(old, "start");
    f.assign();
    const replacement = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(replacement, "start");
    f.complete();
    expect(oldStart).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(f.scene.particleSystems).toEqual([replacement]);
  });

  it("coalesces pending Play and leaves an already playing system untouched", () => {
    const f = fixture(true);
    f.assign();
    const native = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(native, "start");
    const reset = vi.spyOn(native, "reset");
    for (let i = 0; i < 100; i += 1) f.play(true);
    f.complete();
    for (let i = 0; i < 100; i += 1) f.play(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("keeps a synchronous start observer's Stop as the desired state", () => {
    const f = fixture(true);
    f.assign();
    f.scene.particleSystems[0]!.onStartedObservable.addOnce(() => {
      expect(f.service.stats().playing).toBe(1);
      f.play(false);
    });
    f.complete();
    expect(f.service.stats().playing).toBe(0);
  });

  it("keeps assignments and restarted runs frozen when prepared while paused", () => {
    const f = fixture();
    f.service.setPaused(true);
    f.assign();
    const first = f.scene.particleSystems[0] as ParticleSystem;
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
    advance(restarted);
    expect(restarted.getActiveCount()).toBe(0);
    f.service.setPaused(false);
    expect(restarted.updateSpeed).toBe(preparedSpeed);
    advance(restarted);
    expect(restarted.getActiveCount()).toBeGreaterThan(0);
  });

  it("ignores an old upload rejection after a same-key successor starts", async () => {
    let reject!: (error: unknown) => void;
    const firstUpload = new Promise<void>((_resolve, fail) => { reject = fail; });
    let acquisitions = 0;
    const f = fixture(true, undefined, () => ++acquisitions === 1 ? firstUpload : undefined);
    f.assign();
    f.complete();
    f.assign();
    const successor = f.scene.particleSystems[0]!;
    expect(successor.isStarted()).toBe(true);
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

  it.each(["despawn", "reset", "layer-remove", "scene-dispose", "dispose"] as const)("cancels pending starts on %s", (boundary) => {
    const f = fixture(true);
    f.assign();
    const old = f.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(old, "start");
    if (boundary === "despawn") f.service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "actor" });
    else if (boundary === "reset") f.service.resetSession();
    else if (boundary === "layer-remove") f.service.retireSlots((slot) => slot === 1);
    else if (boundary === "scene-dispose") f.scene.dispose();
    else f.service.dispose();
    f.complete();
    expect(start).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.service.stats().systems).toBe(0);
  });

  it("releases failed uploads and removes their custom scene-readiness check", async () => {
    let reject!: (error: unknown) => void;
    const upload = new Promise<void>((_resolve, fail) => { reject = fail; });
    const f = fixture(true, undefined, upload);
    const add = vi.spyOn(f.scene, "addIsReadyCheck");
    const remove = vi.spyOn(f.scene, "removeIsReadyCheck");
    f.assign();
    reject(new Error("controlled upload failure"));
    await vi.waitFor(() => expect(f.diagnostics).toEqual([{ code: "particle.apply_failed", message: "controlled upload failure", assetGuid: "system" }]));
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map(([check]) => check)).toEqual(add.mock.calls.map(([check]) => check));
    for (let i = 0; i < 20; i += 1) f.play(true);
    expect(f.diagnostics).toHaveLength(1);
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

  it("returns native systems, emitter geometry, observers and leases to the warmed baseline", async () => {
    const f = fixture();
    const before = { meshes: f.scene.meshes.length, geometry: f.scene.geometries.length,
      before: f.scene.onBeforeRenderObservable.observers.length, after: f.scene.onAfterRenderObservable.observers.length };
    for (let i = 0; i < 200; i += 1) { f.assign(); f.service.resetSession(); }
    await vi.waitFor(() => expect(f.scene.onBeforeRenderObservable.observers.length).toBe(before.before));
    expect(f.scene.onAfterRenderObservable.observers.length).toBe(before.after);
    expect(f.scene.meshes).toHaveLength(before.meshes);
    expect(f.scene.geometries).toHaveLength(before.geometry);
    expect(f.scene.particleSystems).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(200);
    expect(f.texture.isReady()).toBe(true);
  });
});
