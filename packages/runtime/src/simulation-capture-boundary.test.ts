import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import { simulationCaptureChunks } from "./simulation-capture-transport";
import { SnapshotPublisher } from "./snapshot-publisher";

describe("Simulation final capture boundary", () => {
  it("retains known cold asset references without treating their identity as a loaded resource", async () => {
    const baseline = { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero", properties: { lookup: "cold" } })] };
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      sessionGeneration: 6, sessionMode: "simulate", playScene: baseline, playSceneGuid: "root", simulationAssetGuids: ["root", "hero-class", "cold"] });
    try {
      await runtime.loadScripts([{ classId: "Hero", parentClassId: "Actor", assetGuid: "hero-class", anchors: [], source: "", entryPoints: [],
        variables: [{ name: "lookup", type: "asset", defaultValue: null }] }]);
      runtime.registerSceneContent({ assetGuids: ["root", "hero-class"] });
      runtime.realizePlayWorld(); runtime.start();
      const boundary = await runtime.quiesceSimulation({ sessionGeneration: 6, requestId: 1 });
      const result = await runtime.captureSimulationState({ sessionGeneration: 6, requestId: 2, renderRevision: boundary.commandRevision });
      expect(result).toMatchObject({ ok: true, scene: { actors: [expect.objectContaining({ properties: expect.objectContaining({ lookup: "cold" }) })] } });
    } finally { runtime.stop(); }
  });

  it("captures gameplay gravity without mutating the frozen prepared document", async () => {
    const baseline = { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero" })] };
    const gravity = [...baseline.settings.gravity];
    Object.freeze(baseline.settings); Object.freeze(baseline);
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      sessionGeneration: 6, sessionMode: "simulate", playScene: baseline, playSceneGuid: "root" });
    try {
      await runtime.loadScripts([{ classId: "Hero", parentClassId: "Actor", assetGuid: "hero", anchors: [],
        source: 'export function onBeginPlay(ctx) { ctx.setVariableOn(ctx.getSceneReference(), "gravity", {x:1,y:-3,z:2}); }',
        entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }] }]);
      runtime.realizePlayWorld(); runtime.start();
      const boundary = await runtime.quiesceSimulation({ sessionGeneration: 6, requestId: 1 });
      const result = await runtime.captureSimulationState({ sessionGeneration: 6, requestId: 2, renderRevision: boundary.commandRevision });
      expect(result).toMatchObject({ ok: true, scene: { settings: { gravity: [1, -3, 2] } } });
      expect(baseline.settings.gravity).toEqual(gravity);
    } finally { runtime.stop(); }
  });

  it("captures before destructive End Play, hydrates retained references, and keeps the quiescent clock frozen", async () => {
    const baseline = { ...createDefaultScene(), actors: [createActor("before", "Before", { classId: "Hero" })] };
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      sessionGeneration: 6, sessionMode: "simulate", playScene: baseline, playSceneGuid: "root" });
    let captured: Awaited<ReturnType<typeof runtime.captureSimulationState>> | undefined;
    try {
      await runtime.loadScripts([{ classId: "Hero", parentClassId: "Actor", assetGuid: "hero", source: "", anchors: [], entryPoints: [],
        variables: [{ name: "target", type: "actor", defaultValue: null }, { name: "health", type: "float", defaultValue: 1 }] }]);
      runtime.realizePlayWorld(); runtime.start();
      const world = runtime.getWorld();
      const spawned = world.createActor({ classId: "Hero", guid: "spawned", variables: { health: 20 } });
      world.spawnActorNow(spawned); world.findActor("before")!.setVariable("target", spawned);
      const boundary = await runtime.quiesceSimulation({ sessionGeneration: 6, requestId: 1 });
      expect(boundary.success).toBe(true);
      captured = await runtime.captureSimulationState({ sessionGeneration: 6, requestId: 2, renderRevision: boundary.commandRevision });
      expect(captured.ok).toBe(true);
      if (!captured.ok) throw new Error(captured.reason);
      expect(captured.scene.actors).toHaveLength(2);
      expect(baseline.actors).toHaveLength(1);
      expect(captured.scene.actors.find(actor => actor.id === "before")!.properties?.target).toMatchObject({ $sceneValue: "reference" });
      runtime.resume("loading"); runtime.advance(200); runtime.tick();
      expect(world.clock.tickIndex).toBe(boundary.tickIndex);
    } finally { runtime.stop(); }
    if (!captured?.ok) throw new Error("capture unavailable");
    const loaded = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: captured.scene });
    try {
      loaded.realizePlayWorld();
      const before = loaded.getWorld().findActor("before")!;
      expect(before.getVariable("target")).toBe(loaded.getWorld().getActors().find(actor => actor.guid !== "before"));
    } finally { loaded.stop(); }
  });

  it("rejects unmatched render ownership and capture budgets without stopping or changing authored data", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, sessionGeneration: 8,
      sessionMode: "simulate", playScene: { ...createDefaultScene(), actors: [createActor("before", "Before")] }, playSceneGuid: "root" });
    try {
      runtime.realizePlayWorld(); runtime.start();
      expect((await runtime.captureSimulationState({ sessionGeneration: 8, requestId: 1, renderRevision: 0 })).ok).toBe(false);
      const boundary = await runtime.quiesceSimulation({ sessionGeneration: 8, requestId: 2 });
      expect(await runtime.captureSimulationState({ sessionGeneration: 8, requestId: 3, renderRevision: boundary.commandRevision - 1 })).toMatchObject({ ok: false, code: "boundary" });
      expect(await runtime.captureSimulationState({ sessionGeneration: 8, requestId: 4, renderRevision: boundary.commandRevision, maxBytes: 1 })).toMatchObject({ ok: false, code: "budget" });
      expect(runtime.getWorld().getActors()).toHaveLength(1);
      expect((await runtime.captureSimulationState({ sessionGeneration: 8, requestId: 5, renderRevision: boundary.commandRevision })).ok).toBe(true);
    } finally { runtime.stop(); }
  });

  it("answers a quiescence step that throws and accepts a retry with a newer request ID", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, sessionGeneration: 9,
      sessionMode: "simulate", playScene: { ...createDefaultScene(), actors: [createActor("before", "Before")] }, playSceneGuid: "root" });
    const flush = vi.spyOn(SnapshotPublisher.prototype, "flushDeferred");
    try {
      runtime.realizePlayWorld(); runtime.start();
      flush.mockImplementationOnce(() => { throw new Error("Deferred snapshot failed."); });
      expect(await runtime.quiesceSimulation({ sessionGeneration: 9, requestId: 1 })).toMatchObject({ success: false, reason: "Deferred snapshot failed." });
      const boundary = await runtime.quiesceSimulation({ sessionGeneration: 9, requestId: 2 });
      expect(boundary.success).toBe(true);
      expect((await runtime.captureSimulationState({ sessionGeneration: 9, requestId: 3, renderRevision: boundary.commandRevision })).ok).toBe(true);
    } finally { flush.mockRestore(); runtime.stop(); }
  });

  it("streams large escaped and Unicode values in bounded chunks without changing the JSON meaning", () => {
    const input = { crossed: "x".repeat(2047) + "🐿", title: '\\"\n😀'.repeat(12000), value: [null, true, 1, { reference: "actor" }] };
    const chunks = [...simulationCaptureChunks(input)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.byteLength <= 64 * 1024)).toBe(true);
    const decoder = new TextDecoder();
    const serialized = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
    expect(JSON.parse(serialized)).toEqual(input);
    expect(chunks.reduce((size, chunk) => size + chunk.byteLength, 0)).toBe(new TextEncoder().encode(JSON.stringify(input)).byteLength);
  });
});
