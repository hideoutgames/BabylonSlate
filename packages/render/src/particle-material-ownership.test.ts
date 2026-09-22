import { NodeMaterial, ParticleSystem, RawTexture, Scene } from "@babylonjs/core";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import { MaterialLibrary } from "./material-library";
import { acquireParticleMaterial } from "./particle-material";
import { ParticleService } from "./particle-service";
import type { ResourceLease } from "./resource-cache";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe("scene and emitter material ownership", () => {
  it.each([false, true])("isolates one graph's two emitter textures and scenes (reverse=%s)", async (reverse) => {
    const host = createTestEngine();
    const overlay = new Scene(host.engine);
    const library = new MaterialLibrary();
    const document = createDefaultMaterialDocument("Shared graph", "particle");
    const red = RawTexture.CreateRGBATexture(new Uint8Array([255, 0, 0, 255]), 1, 1, host.scene);
    const blue = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 255, 255]), 1, 1, overlay);
    const materials: ResourceLease<NodeMaterial>[] = [];
    let textureOwners = 0;
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      sceneForSlot: (slot) => slot === 2 ? overlay : host.scene,
      acquireTexture: (guid) => {
        textureOwners += 1;
        return { key: guid, resource: guid === "red" ? red : blue, release: () => { textureOwners -= 1; } };
      },
      acquireMaterial: (guid, owner) => {
        const lease = acquireParticleMaterial(library, guid, document, owner)!;
        materials.push(lease);
        return lease;
      },
    });
    cleanups.push(() => { service.dispose(); library.dispose(); overlay.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary({ emitters: new Map(["red", "blue"].map((guid) => [guid, {
      ...createDefaultParticleEmitterPayload(), textureGuid: guid, materialGuid: "graph",
    }])), systems: new Map(["red", "blue"].map((guid) => [guid, { ...createDefaultParticleSystemPayload(), emitterGuids: [guid] }])) });
    for (const guid of reverse ? ["blue", "red"] : ["red", "blue"]) service.handleCommand({ type: "assignParticle",
      slotId: guid === "red" ? 1 : 2, actorGuid: guid, componentId: "particle", particleSystemGuid: guid });
    await vi.waitFor(() => {
      expect(host.scene.particleSystems[0]?.isStarted()).toBe(true);
      expect(overlay.particleSystems[0]?.isStarted()).toBe(true);
    });
    expect(materials[0]!.resource).not.toBe(materials[1]!.resource);
    for (const lease of materials) {
      const material = lease.resource;
      const expected = material.getScene() === host.scene ? red : blue;
      const blocks = material.attachedBlocks.filter((block) => block instanceof ParticleTextureBlock);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect((block as ParticleTextureBlock).texture).toBe(expected);
    }
    const survivor = overlay.particleSystems[0]!;
    service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
    expect(textureOwners).toBe(1);
    expect(host.scene.particleSystems).toHaveLength(0);
    expect(overlay.particleSystems).toEqual([survivor]);
    expect(survivor.particleTexture).toBe(blue);
    expect(overlay.materials).toContain(materials.find((lease) => lease.resource.getScene() === overlay)!.resource);
    service.dispose();
    expect(textureOwners).toBe(0);
  });

  it("Stop before material completion cancels publication and removes every readiness check", async () => {
    const host = createTestEngine();
    const library = new MaterialLibrary();
    const document = createDefaultMaterialDocument("Delayed graph", "particle");
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, host.scene);
    let complete!: () => void;
    const delay = new Promise<void>((resolve) => { complete = resolve; });
    const release = vi.fn();
    const add = vi.spyOn(host.scene, "addIsReadyCheck");
    const remove = vi.spyOn(host.scene, "removeIsReadyCheck");
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      resolveTexture: () => texture,
      acquireMaterial: (guid, owner) => {
        const lease = acquireParticleMaterial(library, guid, document, owner)!;
        return { ...lease, ready: Promise.all([lease.ready, delay]).then(() => {}), release: () => { release(); lease.release(); } };
      },
    });
    cleanups.push(() => { service.dispose(); library.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary({ emitters: new Map([["emitter", { ...createDefaultParticleEmitterPayload(), textureGuid: "texture", materialGuid: "graph" }]]),
      systems: new Map([["system", { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] }]]) });
    service.handleCommand({ type: "assignParticle", actorGuid: "actor", componentId: "particle", slotId: 1, particleSystemGuid: "system" });
    const old = host.scene.particleSystems[0] as ParticleSystem;
    const start = vi.spyOn(old, "start");
    service.handleCommand({ type: "setParticlePlaying", actorGuid: "actor", playing: false });
    complete();
    await delay;
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.scene.particleSystems).toHaveLength(0);
    expect(new Set(remove.mock.calls.map(([check]) => check))).toEqual(new Set(add.mock.calls.map(([check]) => check)));
  });
});
