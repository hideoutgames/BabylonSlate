import { NullEngine, ParticleSystem, RawTexture, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ParticleService } from "./particle-service";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function fixture(pending = false, sceneForSlot?: (slot: number) => Scene | null) {
  const host = createTestEngine();
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, host.scene);
  let ready = !pending;
  Object.defineProperty(texture, "url", { get: () => "blob:controlled-particle-texture" });
  texture.isReady = () => ready;
  const release = vi.fn();
  const service = new ParticleService({ scene: host.scene, gpuSupported: false, sceneForSlot,
    acquireTexture: () => ({ key: "texture:1", resource: texture, release }),
  });
  service.setLibrary({
    emitters: new Map([["emitter", { ...createDefaultParticleEmitterPayload(), textureGuid: "texture" }]]),
    systems: new Map([["system", { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] }]]),
  });
  const assign = () => service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system", play: true });
  const play = (playing: boolean) => service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", componentId: "particle", playing });
  cleanups.push(() => { service.dispose(); host.scene.dispose(); host.engine.dispose(); });
  return { ...host, service, texture, release, assign, play, complete: () => { ready = true; texture.onLoadObservable.notifyObservers(texture); } };
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
});
