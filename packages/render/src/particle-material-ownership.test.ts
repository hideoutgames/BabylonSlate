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
  it.each([{ reverse: false, splitScene: false }, { reverse: true, splitScene: false }, { reverse: false, splitScene: true }, { reverse: true, splitScene: true }])("isolates one graph's emitter textures ($reverse/$splitScene)", async ({ reverse, splitScene }) => {
    const host = createTestEngine();
    const overlay = new Scene(host.engine);
    const blueScene = splitScene ? overlay : host.scene;
    const library = new MaterialLibrary();
    const document = createDefaultMaterialDocument("Shared graph", "particle");
    const red = RawTexture.CreateRGBATexture(new Uint8Array([255, 0, 0, 255]), 1, 1, host.scene);
    const blue = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 255, 255]), 1, 1, blueScene);
    const materials: ResourceLease<NodeMaterial>[] = [];
    const expectedTextures = new Map<NodeMaterial, RawTexture>();
    let requestedTexture = red;
    let textureOwners = 0;
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      sceneForSlot: (slot) => slot === 2 ? blueScene : host.scene,
      acquireTexture: (guid) => {
        textureOwners += 1;
        return { key: guid, resource: guid === "red" ? red : blue, release: () => { textureOwners -= 1; } };
      },
      acquireMaterial: (guid, owner) => {
        const lease = acquireParticleMaterial(library, guid, document, owner)!;
        materials.push(lease);
        expectedTextures.set(lease.resource, requestedTexture);
        return lease;
      },
    });
    cleanups.push(() => { service.dispose(); library.dispose(); overlay.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary({ emitters: new Map(["red", "blue"].map((guid) => [guid, {
      ...createDefaultParticleEmitterPayload(), textureGuid: guid, materialGuid: "graph",
    }])), systems: new Map(["red", "blue"].map((guid) => [guid, { ...createDefaultParticleSystemPayload(), emitterGuids: [guid] }])) });
    for (const guid of reverse ? ["blue", "red"] : ["red", "blue"]) {
      requestedTexture = guid === "red" ? red : blue;
      service.handleCommand({ type: "assignParticle",
        slotId: guid === "red" ? 1 : 2, actorGuid: guid, componentId: "particle", particleSystemGuid: guid });
    }
    await vi.waitFor(() => {
      expect(host.scene.particleSystems[0]?.isStarted()).toBe(true);
      expect(blueScene.particleSystems.find((system) => system.particleTexture === blue)?.isStarted()).toBe(true);
    });
    expect(materials[0]!.resource).not.toBe(materials[1]!.resource);
    for (const lease of materials) {
      const material = lease.resource;
      const expected = expectedTextures.get(material)!;
      expect(material.getScene()).toBe(expected === red ? host.scene : blueScene);
      const blocks = material.attachedBlocks.filter((block) => block instanceof ParticleTextureBlock);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect((block as ParticleTextureBlock).texture).toBe(expected);
    }
    const survivor = blueScene.particleSystems.find((system) => system.particleTexture === blue)!;
    service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
    expect(textureOwners).toBe(1);
    expect(host.scene.particleSystems).toHaveLength(splitScene ? 0 : 1);
    expect(blueScene.particleSystems).toEqual([survivor]);
    expect(survivor.particleTexture).toBe(blue);
    expect(blueScene.materials).toContain(materials.find((lease) => expectedTextures.get(lease.resource) === blue)!.resource);
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
