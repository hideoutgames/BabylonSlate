import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, identitySerializedTransform } from "@babylonslate/core";
import type { CommandMessage, RuntimeInspectorAction, RuntimeInspectorResult, RuntimeObjectIdentity } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

async function fixture(mode: "simulate" | "play" = "simulate", deferMaterialEdits = false) {
  const commands: CommandMessage[] = [];
  const mesh = createMeshComponent("mesh", "box"); mesh.properties.materialGuid = "mat";
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    sessionGeneration: 4, sessionMode: mode, playSceneGuid: "root", deferMaterialEdits,
    playScene: { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero", components: [mesh] })] },
    materialParameterCatalog: { mat: { domain: "surface", planHash: "mat", parameters: { Gain: { kind: "float", value: 1 } } } },
    onCommand: command => commands.push(command) });
  await runtime.loadScripts([{ classId: "Hero", assetGuid: "hero-class", parentClassId: "Actor", source: "", anchors: [], entryPoints: [],
    variables: [{ name: "health", type: "float", defaultValue: 10 }, { name: "target", type: "actor", defaultValue: null },
      { name: "inventory", type: "string", container: "array", defaultValue: [] }] }]);
  runtime.realizePlayWorld(); runtime.start();
  let requestId = 0;
  const request = (action: RuntimeInspectorAction) => runtime.requestRuntimeInspector({ sessionGeneration: 4, requestId: ++requestId, action });
  const tree = await request({ kind: "identities" });
  const rows = tree.payload?.kind === "identities" ? tree.payload.rows : [];
  const actor = rows.find(row => row.kind === "actor")!.identity;
  const component = rows.find(row => row.kind === "component")!.identity;
  return { runtime, commands, request, actor, component };
}
const mutation = (target: RuntimeObjectIdentity, sequence: number, value: number): RuntimeInspectorAction =>
  ({ kind: "setProperty", target, sequence, property: "health", value });

describe("bounded runtime Inspector", () => {
  it("reads selected reflection metadata and applies correlated writes while paused without authoring or ticking", async () => {
    const { runtime, request, actor } = await fixture();
    try {
      runtime.pause();
      const selection = await request({ kind: "selection", target: actor });
      expect(selection.payload).toMatchObject({ kind: "selection", properties: expect.arrayContaining([
        expect.objectContaining({ key: "health", typeId: "float", capability: "live", value: 10 }),
      ]) });
      const result = await request(mutation(actor, 1, 42));
      expect(result).toMatchObject({ success: true, tickIndex: 0, payload: { kind: "mutation", sequence: 1, effectiveValue: 42 } });
      expect(runtime.getWorld().findActor("hero")!.getVariable("health")).toBe(42);
      expect((await request(mutation(actor, 1, 9))).success).toBe(false);
      expect((await request(mutation(actor, 2, Infinity))).success).toBe(false);
      expect((await request({ kind: "setProperty", target: actor, sequence: 3, property: "parentId", value: "other" })).success).toBe(false);
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });

  it("keeps GUID reuse and destroyed components distinct from the selected lifetime", async () => {
    const { runtime, request, actor, component } = await fixture();
    try {
      const world = runtime.getWorld(); const old = world.findActor("hero")!;
      const before = await request({ kind: "identities" });
      expect((await request({ kind: "identities", knownRevision: before.structuralRevision })).payload).toMatchObject({ kind: "identities", unchanged: true, rows: [] });
      world.destroyActor("hero"); runtime.tick();
      world.spawnActorNow(world.createActor({ guid: "hero", classId: "Hero" }));
      expect(old.destroyed).toBe(true);
      expect((await request(mutation(actor, 1, 20))).success).toBe(false);
      expect((await request({ kind: "selection", target: component })).success).toBe(false);
      const tree = await request({ kind: "identities", knownRevision: before.structuralRevision });
      expect(tree.structuralRevision).toBeGreaterThan(before.structuralRevision);
      expect(tree.payload).toMatchObject({ kind: "identities", rows: [expect.objectContaining({ identity: expect.objectContaining({ actorGuid: "hero" }) })] });
      if (tree.payload?.kind === "identities") expect(tree.payload.rows[0]!.identity.actorToken).not.toBe(actor.actorToken);
    } finally { runtime.stop(); }
  });

  it("validates reflected actor references and material instance values without touching sibling assets", async () => {
    const { runtime, request, actor, component } = await fixture();
    try {
      runtime.pause();
      expect((await request({ kind: "setProperty", target: actor, sequence: 1, property: "target",
        value: { $runtime: "reference", target: actor } })).success).toBe(true);
      expect(runtime.getWorld().findActor("hero")!.getVariable("target")).toBe(runtime.getWorld().findActor("hero"));
      expect((await request({ kind: "setProperty", target: actor, sequence: 2, property: "target",
        value: { $runtime: "reference", target: component } })).success).toBe(false);
      expect((await request({ kind: "setMaterialParameter", target: component, sequence: 1, materialGuid: "mat",
        parameter: "Gain", value: { kind: "float", value: 0.2 } })).success).toBe(true);
      expect((await request({ kind: "setMaterialParameter", target: component, sequence: 2, materialGuid: "mat",
        parameter: "Gain", value: { kind: "texture", textureAssetGuid: "missing" } })).success).toBe(false);
      const details = await request({ kind: "selection", target: component });
      expect(details.payload).toMatchObject({ kind: "selection", properties: expect.arrayContaining([
        expect.objectContaining({ key: "material:Gain", value: { kind: "float", value: 0.2 } }),
      ]) });
    } finally { runtime.stop(); }
  });

  it("holds material acknowledgments through preparation and renderer application, reverting a failed owner", async () => {
    const { runtime, request, component, commands } = await fixture("simulate", true);
    try {
      runtime.pause(); let settled = false;
      const result = request({ kind: "setMaterialParameter", target: component, sequence: 1, materialGuid: "mat",
        parameter: "Gain", value: { kind: "float", value: 0.2 } }).then(value => { settled = true; return value; });
      await Promise.resolve();
      const prepare = commands.find(command => command.type === "prepareRuntimeMaterialEdit")!;
      expect(prepare.type).toBe("prepareRuntimeMaterialEdit");
      if (prepare.type !== "prepareRuntimeMaterialEdit") throw new Error("missing preparation");
      expect(settled).toBe(false);
      runtime.applyRuntimeMaterialEditResult({ type: "runtimeMaterialEditPrepared", sessionGeneration: 4,
        requestId: prepare.requestId, editToken: prepare.editToken, success: true });
      await Promise.resolve();
      expect(commands).toContainEqual(expect.objectContaining({ type: "setMaterialParameter", preparedEditToken: prepare.editToken }));
      expect(settled).toBe(false);
      runtime.applyRuntimeMaterialEditResult({ type: "runtimeMaterialEditApplied", sessionGeneration: 4,
        requestId: prepare.requestId, editToken: prepare.editToken, success: false, reason: "Texture became unavailable." });
      expect(await result).toMatchObject({ success: false, reason: "Texture became unavailable." });
      const details = await request({ kind: "selection", target: component });
      expect(details.payload).toMatchObject({ properties: expect.arrayContaining([
        expect.objectContaining({ key: "material:Gain", value: { kind: "float", value: 1 } }),
      ]) });
      expect(commands).toContainEqual(expect.objectContaining({ type: "releaseRuntimeMaterialPreparation", editToken: prepare.editToken, committed: false }));
    } finally { runtime.stop(); }
  });

  it("publishes a paused transform with a fresh presentation identity without a new simulation tick", async () => {
    const { runtime, request, actor, commands } = await fixture();
    try {
      runtime.pause(); const transform = identitySerializedTransform(); transform.position = [7, 8, 9];
      const result = await request({ kind: "setTransform", target: actor, sequence: 1, transform });
      expect(result).toMatchObject({ success: true, tickIndex: 0, payload: { effectiveValue: transform } });
      expect(runtime.getWorld().findActor("hero")!.transform.position).toEqual({ x: 7, y: 8, z: 9 });
      expect(commands).toContainEqual(expect.objectContaining({ type: "resetActorInterpolation", actorGuid: "hero", frameId: result.frameId }));
      expect((await request({ kind: "setTransform", target: actor, sequence: 2,
        transform: { ...transform, rotation: [0, 0, 0, 0] } })).success).toBe(false);
    } finally { runtime.stop(); }
  });

  it("converts world gizmo poses against the current actor and component parent chains", async () => {
    const { runtime, request, actor, component } = await fixture();
    try {
      const world = runtime.getWorld();
      const parent = world.createActor({ classId: "Actor", guid: "parent" }); parent.transform.position.x = 10; parent.transform.scale.x = 2;
      world.spawnActorNow(parent); const hero = world.findActor("hero")!; hero.setVariable("parentId", parent.guid);
      runtime.pause(); const transform = identitySerializedTransform(); transform.position = [18, 0, 0]; transform.scale = [2, 1, 1];
      expect((await request({ kind: "setTransform", target: actor, sequence: 1, transform, space: "world" })).success).toBe(true);
      expect(hero.transform.position.x).toBe(4); expect(hero.transform.scale.x).toBe(1);
      transform.position = [22, 0, 0];
      expect((await request({ kind: "setTransform", target: component, sequence: 1, transform, space: "world" })).success).toBe(true);
      expect(hero.components[0]!.transform.position.x).toBe(2);
    } finally { runtime.stop(); }
  });

  it("teleports a paused physics body through its owner and preserves velocity", async () => {
    const { runtime, request, actor } = await fixture();
    try {
      const world = runtime.getWorld(); const body = world.findActor("hero")!;
      body.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: {
        motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0,
      } }));
      body.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      } }));
      const sync = runtime.getPhysicsSync()!; sync.syncFromWorld(world); sync.addImpulse(body.guid, { x: 3, y: 0, z: 0 });
      const velocity = sync.getActorVelocity(body);
      runtime.pause(); const transform = identitySerializedTransform(); transform.position = [7, 0, 0];
      expect((await request({ kind: "setTransform", target: actor, sequence: 1, transform })).success).toBe(true);
      expect(sync.getActorVelocity(body)).toMatchObject({ linear: velocity!.linear, angular: velocity!.angular });
      expect(sync.getActorVelocity(body)!.centerOfMass.x).toBeCloseTo(7);
      expect(sync.getBackend().lineTrace({ x: 7, y: 4, z: 0 }, { x: 7, y: -4, z: 0 }).hit).toBe(true);
      expect(sync.getBackend().lineTrace({ x: 0, y: 4, z: 0 }, { x: 0, y: -4, z: 0 }).hit).toBe(false);
      expect(world.clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });

  it("pages structural identities and values within 64 KiB without polling unselected properties", async () => {
    const { runtime, request, actor } = await fixture();
    try {
      const world = runtime.getWorld();
      world.findActor("hero")!.setVariable("inventory", Array.from({ length: 10000 }, (_, index) => `item-${index}`));
      for (let index = 0; index < 260; index++) world.spawnActorNow(world.createActor({ guid: `extra-${index}`, classId: "Actor" }));
      const first = await request({ kind: "identities" });
      expect(first.payload?.kind).toBe("identities");
      if (first.payload?.kind !== "identities") throw new Error("identity page missing");
      expect(first.payload.nextCursor).toBeDefined();
      expect(first.payload.rows.length).toBeLessThanOrEqual(128);
      const second = await request({ kind: "identities", cursor: first.payload.nextCursor });
      expect(second.success).toBe(true);
      const value = await request({ kind: "value", target: actor, property: "inventory" });
      expect(value.truncated).toBe(true);
      expect(value.payload).toMatchObject({ kind: "value", nextOffset: expect.any(Number) });
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(65536);
    } finally { runtime.stop(); }
  });

  it("rejects writes outside Simulation and bounds pending transport without applying partial requests", async () => {
    const { runtime, request, actor } = await fixture("play");
    try { expect((await request(mutation(actor, 1, 99))).success).toBe(false); }
    finally { runtime.stop(); }
    const next = await fixture();
    const pending: Promise<RuntimeInspectorResult>[] = [];
    for (let index = 0; index < 33; index++) pending.push(next.request(mutation(next.actor, index + 1, index)));
    const overflow = await pending[32]!;
    expect(overflow.success).toBe(false);
    next.runtime.stop();
    expect((await next.request(mutation(next.actor, 34, 34))).success).toBe(false);
    await Promise.all(pending);
  });
});
