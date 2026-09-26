import { ParticleSystem, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { PARTICLE_UPDATE_SPEED } from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import {
  createParticleMaterialResolver,
  createParticlePreviewScene,
} from "./particle-preview";
import { isSkyboxMesh } from "./skybox";

describe("createParticlePreviewScene", () => {
  const handles: Array<{ engine: { dispose: () => void } }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.engine.dispose();
    }
  });

  it("builds a disposable Scene on the shared Engine with a hidden mesh", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine);
    expect(host.scene).toBeTruthy();
    expect(host.camera).toBeTruthy();
    expect(host.mesh.isVisible).toBe(false);
    expect(host.scene.meshes.some((mesh) => isSkyboxMesh(mesh))).toBe(false);
    host.dispose();
  });

  it("adds an unpickable default skybox when skybox is on", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine, { skybox: true });
    const skybox = host.scene.meshes.find((mesh) => isSkyboxMesh(mesh));
    expect(skybox).toBeTruthy();
    expect(skybox!.infiniteDistance).toBe(false);
    expect(skybox!.isPickable).toBe(false);
    host.dispose();
  });

  it("simulates particles by wall-clock time between preview renders", () => {
    const handle = createTestEngine();
    handles.push(handle);
    let clock = 0;
    const host = createParticlePreviewScene(handle.engine, { now: () => clock });
    const system = new ParticleSystem("preview-clock", 256, host.scene);
    system.emitter = Vector3.Zero();
    system.updateSpeed = PARTICLE_UPDATE_SPEED;
    system.emitRate = 60;
    system.minLifeTime = system.maxLifeTime = 10;
    // NullEngine never uploads the readiness texture; readiness is not under test.
    system.isReady = () => true;
    system.start();
    // The shared Engine loop is idle, so its delta is stale; preview time must follow the clock.
    for (let frame = 0; frame < 20; frame += 1) {
      clock += 50;
      host.scene.render();
    }
    // One second of wall time at 60 particles per second.
    expect(system.getActiveCount()).toBeGreaterThanOrEqual(55);
    expect(system.getActiveCount()).toBeLessThanOrEqual(65);
    // A resumed tab advances one capped step, not the whole hidden interval.
    const before = system.getActiveCount();
    clock += 60_000;
    host.scene.render();
    expect(system.getActiveCount() - before).toBeLessThanOrEqual(7);
    host.dispose();
  });

  it("compiles a particle-domain material for Preview createEffectForParticles", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine);
    const resolver = createParticleMaterialResolver({
      scene: host.scene,
      documents: new Map([
        ["mat-1", createDefaultMaterialDocument("Sparks", "particle")],
      ]),
    });
    const owner = { scene: host.scene, instanceKey: "preview:emitter:1" };
    const lease = resolver.acquire("mat-1", owner);
    const material = lease?.resource;
    expect(material).toBeTruthy();
    expect(material?.mode).toBe(2);
    expect(resolver.acquire("missing", owner)).toBeNull();
    lease?.release();
    resolver.dispose();
    host.dispose();
  });
});
