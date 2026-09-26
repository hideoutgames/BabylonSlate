import { NodeMaterial, ParticleSystem, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeParticleEmitterPayload } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import { MaterialLibrary } from "./material-library";
import { acquireParticleMaterial } from "./particle-material";
import { ParticleService, type ParticleMaterialOwner } from "./particle-service";
import type { ResourceLease } from "./resource-cache";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const emitter = { kind: "basic" as const, payload: normalizeParticleEmitterPayload({ render: { materialGuid: "graph" } }) };
const system = (guid: string) => ({ emitterGuids: [guid], space: "world" as const, previewSkybox: true });

describe("scene and emitter material ownership", () => {
  it.each([{ reverse: false, splitScene: false }, { reverse: true, splitScene: false }, { reverse: false, splitScene: true }, { reverse: true, splitScene: true }])("gives each emitter its own Material instance in its owning scene ($reverse/$splitScene)", async ({ reverse, splitScene }) => {
    const host = createTestEngine();
    const overlay = new Scene(host.engine);
    const blueScene = splitScene ? overlay : host.scene;
    const library = new MaterialLibrary();
    const document = createDefaultMaterialDocument("Shared graph", "particle");
    const materials: Array<{ lease: ResourceLease<NodeMaterial>; owner: ParticleMaterialOwner }> = [];
    let owners = 0;
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      sceneForSlot: (slot) => slot === 2 ? blueScene : host.scene,
      acquireMaterial: (guid, owner) => {
        const lease = acquireParticleMaterial(library, guid, document, owner)!;
        materials.push({ lease, owner });
        owners += 1;
        return { ...lease, release: () => { owners -= 1; lease.release(); } };
      },
    });
    cleanups.push(() => { service.dispose(); library.dispose(); overlay.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary({ emitters: new Map([["red", emitter], ["blue", emitter]]),
      systems: new Map(["red", "blue"].map((guid) => [guid, system(guid)])) });
    for (const guid of reverse ? ["blue", "red"] : ["red", "blue"]) {
      service.handleCommand({ type: "assignParticle",
        slotId: guid === "red" ? 1 : 2, actorGuid: guid, componentId: "particle", particleSystemGuid: guid });
    }
    const systems = [...new Set([...host.scene.particleSystems, ...blueScene.particleSystems])] as ParticleSystem[];
    expect(systems).toHaveLength(2);
    await vi.waitFor(() => { for (const native of systems) expect(native.isStarted()).toBe(true); });
    expect(materials).toHaveLength(2);
    expect(materials[0]!.lease.resource).not.toBe(materials[1]!.lease.resource);
    for (const { lease, owner } of materials) {
      expect(owner.scene).toBe(owner.instanceKey.includes(":blue:") ? blueScene : host.scene);
      expect(lease.resource.getScene()).toBe(owner.scene);
    }
    const blue = blueScene.particleSystems.find((native) => native.name.includes("blue"))!;
    const blueMaterial = materials.find(({ owner }) => owner.instanceKey.includes(":blue:"))!.lease;
    service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
    expect(owners).toBe(1);
    expect(host.scene.particleSystems).toHaveLength(splitScene ? 0 : 1);
    expect(blueScene.particleSystems).toEqual([blue]);
    expect(blueScene.materials).toContain(blueMaterial.resource);
    service.dispose();
    expect(owners).toBe(0);
  });

  it("Stop before material completion cancels publication and removes every readiness check", async () => {
    const host = createTestEngine();
    const library = new MaterialLibrary();
    const document = createDefaultMaterialDocument("Delayed graph", "particle");
    let complete!: () => void;
    const delay = new Promise<void>((resolve) => { complete = resolve; });
    const release = vi.fn();
    const add = vi.spyOn(host.scene, "addIsReadyCheck");
    const remove = vi.spyOn(host.scene, "removeIsReadyCheck");
    const service = new ParticleService({ scene: host.scene, gpuSupported: false,
      acquireMaterial: (guid, owner) => {
        const lease = acquireParticleMaterial(library, guid, document, owner)!;
        return { ...lease, ready: Promise.all([lease.ready, delay]).then(() => {}), release: () => { release(); lease.release(); } };
      },
    });
    cleanups.push(() => { service.dispose(); library.dispose(); host.scene.dispose(); host.engine.dispose(); });
    service.setLibrary({ emitters: new Map([["emitter", emitter]]), systems: new Map([["system", system("emitter")]]) });
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
