import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, type SerializedScene } from "@babylonslate/core";
import { readActorSlot, readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { sceneAssetClassId } from "@babylonslate/object-model";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

function marker(id: string, x = 0, target = "child") {
  return createActor(id, id, { classId: "SceneStreamingActor",
    transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
    components: [{ id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: target, sceneName: "Child" },
      transform: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { id: "label", classId: "Text3DComponent", properties: { editorOnly: true, text: "Child" } }] });
}

function logic(classId: string, parentClassId = "Actor", begin = ""): CompiledScript {
  return { classId, parentClassId, assetGuid: `${classId}-script`, anchors: [],
    source: `export function begin(ctx) { ctx.self.setVariable("began", true); ${begin} }
      export function tick(ctx) { ctx.self.setVariable("ticks", Number(ctx.self.getVariable("ticks") ?? 0) + 1); }`,
    entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }, { name: "tick", event: "onTick", isAsync: false }] };
}

async function setup(options: { child?: SerializedScene; deferred?: boolean; scripts?: CompiledScript[]; scenes?: Record<string, SerializedScene>; yieldControl?: (signal: AbortSignal) => Promise<void> } = {}) {
  const commands: CommandMessage[] = [];
  const scene = { ...createDefaultScene(), actors: [marker("left", 10), marker("right", 100),
    createActor("authored", "Parent", { classId: "Parent", components: [createMeshComponent("parent-mesh", "box")] })] };
  const child = options.child ?? { ...createDefaultScene(), name: "Child", actors: [
    createActor("authored", "Child Actor", { classId: "ChildActor",
      transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [createMeshComponent("mesh", "box"),
        { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static" } },
        { id: "collider", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } } ] })] };
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: scene, playSceneGuid: "parent", sceneLibrary: { child, ...options.scenes }, deferSceneModelsReady: options.deferred ?? true,
    ...(options.yieldControl ? { cooperativeSceneLoading: { yieldControl: options.yieldControl } } : {}),
    onCommand: (command) => commands.push(command) });
  await runtime.loadScripts([logic("Parent"), logic("ChildActor"), ...(options.scripts ?? [])]);
  await runtime.realizePlayWorld();
  runtime.notifySceneModelsReady("parent", 1);
  runtime.start();
  return { runtime, commands, world: runtime.getWorld(), left: runtime.getWorld().findActor("left")!, right: runtime.getWorld().findActor("right")! };
}

async function realized(commands: CommandMessage[], actorGuid: string, afterId = 0) {
  await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneStreamRealized" && command.actorGuid === actorGuid && command.streamLoadId > afterId)).toBe(true));
  return [...commands].reverse().find((command): command is Extract<CommandMessage, { type: "sceneStreamRealized" }> =>
    command.type === "sceneStreamRealized" && command.actorGuid === actorGuid && command.streamLoadId > afterId)!;
}

function acknowledge(runtime: RuntimeDriver, command: { actorGuid: string; streamLoadId: number }) {
  runtime.notifySceneStreamReady(command.actorGuid, command.streamLoadId);
}

describe("additive scene streaming", () => {
  it("instances the same scene at component origins and removes only the requested instance", async () => {
    const { runtime, commands, world, left, right } = await setup();
    try {
      const parentScene = world.currentScene;
      const first = runtime.loadSceneStream(left);
      const second = runtime.loadSceneStream(right);
      const firstReady = await realized(commands, "left");
      const secondReady = await realized(commands, "right");
      const children = world.getActors().filter((actor) => actor.classId === "ChildActor");
      expect(children).toHaveLength(2);
      expect(new Set(children.flatMap((actor) => [actor.guid, ...actor.components.map((component) => component.guid)])).size).toBe(8);
      expect(children.every((actor) => actor.getVariable("began") === undefined)).toBe(true);
      runtime.tick();
      expect(world.findActor("authored")!.getVariable("ticks")).toBe(1);
      expect(children.every((actor) => actor.getVariable("ticks") === undefined)).toBe(true);
      acknowledge(runtime, firstReady);
      acknowledge(runtime, secondReady);
      await Promise.all([first, second]);
      const snapshot = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
      expect(runtime.copySnapshot(snapshot)).toBe(true);
      const poses = Array.from({ length: readSnapshotHeader(snapshot).actorCount }, (_, index) => readActorSlot(snapshot, index));
      expect(poses.find((pose) => pose.slotId === firstReady.slotIds[0])?.position.x).toBe(18);
      expect(poses.find((pose) => pose.slotId === secondReady.slotIds[0])?.position.x).toBe(108);
      expect(world.currentScene).toBe(parentScene);
      expect(commands.filter((command) => command.type === "activeScene")).toHaveLength(1);
      expect(commands.some((command) => command.type === "assignMesh" && command.meshKind === "text3d")).toBe(false);
      await runtime.unloadSceneStream(left);
      expect(runtime.getSceneState(left)).toBe("Unloaded");
      expect(runtime.getSceneLoadProgress(left)).toBe(0);
      expect(runtime.getSceneState(right)).toBe("Loaded");
      expect(world.findActor("authored")?.destroyed).toBe(false);
      expect(world.getActors().filter((actor) => actor.classId === "ChildActor")).toHaveLength(1);
      runtime.tick();
      expect(world.getActors().find((actor) => actor.classId === "ChildActor")!.getVariable("ticks")).toBe(1);
    } finally { runtime.stop(); }
  });

  it("holds concurrent blocking loads through readiness without clearing manual pause", async () => {
    const { runtime, commands, world, left, right } = await setup();
    try {
      const first = runtime.loadSceneStream(left, true);
      const second = runtime.loadSceneStream(right, true);
      const firstReady = await realized(commands, "left");
      const secondReady = await realized(commands, "right");
      runtime.tick();
      expect(world.clock.tickIndex).toBe(0);
      expect(world.gameInstance!.getVariable("ticks")).toBe(0);
      runtime.notifySceneStreamProgress("left", firstReady.streamLoadId, 0.5);
      expect(runtime.getSceneLoadProgress(left)).toBe(0.75);
      expect(runtime.getSceneState(left)).toBe("Loading");
      acknowledge(runtime, firstReady);
      await first;
      runtime.tick();
      expect(world.clock.tickIndex).toBe(0);
      runtime.pause();
      acknowledge(runtime, secondReady);
      await second;
      runtime.tick();
      expect(world.clock.tickIndex).toBe(0);
      expect(world.getActors().filter((actor) => actor.classId === "ChildActor").every((actor) => actor.getVariable("began") === undefined)).toBe(true);
      runtime.resume();
      runtime.tick();
      expect(world.clock.tickIndex).toBe(1);
      expect(world.getActors().filter((actor) => actor.classId === "ChildActor").every((actor) => actor.getVariable("began") === true)).toBe(true);
      expect(runtime.getSceneLoadProgress(left)).toBe(1);
      expect(runtime.getSceneLoadProgress(right)).toBe(1);
      await runtime.loadSceneStream(left, true);
      expect(commands.filter((command) => command.type === "sceneStreamBlocking")).toEqual([
        { type: "sceneStreamBlocking", blocking: true }, { type: "sceneStreamBlocking", blocking: false },
      ]);
    } finally { runtime.stop(); }
  });

  it("resolves component references in the explicit target's scene instance", async () => {
    const references: CompiledScript = { classId: "ChildActor", parentClassId: "Actor", assetGuid: "references", anchors: [],
      source: `export function tick(ctx) {
        const other = ctx.getAllActorsOfClass("ChildActor").find(actor => actor !== ctx.self);
        ctx.setVariable("ownMesh", ctx.getComponentById(ctx.self, "mesh"));
        ctx.setVariable("otherMesh", ctx.getComponentById(other, "mesh"));
        ctx.setVariable("sceneMesh", ctx.getComponentById(ctx.getSceneReference(), "mesh"));
      }`,
      entryPoints: [{ name: "tick", event: "onTick", isAsync: false }] };
    const { runtime, world, left, right } = await setup({ deferred: false, scripts: [references] });
    try {
      await runtime.loadSceneStream(left);
      await runtime.loadSceneStream(right);
      const first = world.getActors().find((actor) => actor.classId === "ChildActor" && actor.getVariable("parentId") === "left")!;
      const second = world.getActors().find((actor) => actor.classId === "ChildActor" && actor.getVariable("parentId") === "right")!;
      const firstMesh = first.components.find((component) => component.classId === "MeshComponent")!;
      const secondMesh = second.components.find((component) => component.classId === "MeshComponent")!;
      runtime.tick();
      expect(first.getVariable("ownMesh")).toBe(firstMesh);
      expect(first.getVariable("otherMesh")).toBe(secondMesh);
      expect(first.getVariable("sceneMesh")).toBe(firstMesh);
      expect(second.getVariable("ownMesh")).toBe(secondMesh);
      expect(second.getVariable("otherMesh")).toBe(firstMesh);
      expect(second.getVariable("sceneMesh")).toBe(secondMesh);
    } finally { runtime.stop(); }
  });

  it("cancels pending loads, ignores old acknowledgements, and releases blocking after failure", async () => {
    const { runtime, commands, world, left } = await setup();
    try {
      const first = runtime.loadSceneStream(left, true);
      const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
      const old = await realized(commands, "left");
      const unloading = runtime.unloadSceneStream(left, true);
      expect(runtime.getSceneState(left)).toBe("Unloading");
      await unloading;
      await cancelled;
      const next = runtime.loadSceneStream(left, true);
      const failed = expect(next).rejects.toThrow("Missing model");
      const latest = await realized(commands, "left", old.streamLoadId);
      acknowledge(runtime, old);
      expect(runtime.getSceneState(left)).toBe("Loading");
      runtime.notifySceneStreamFailed("left", latest.streamLoadId, "Missing model");
      await failed;
      expect(world.getActors()).toHaveLength(3);
      runtime.tick();
      expect(world.clock.tickIndex).toBe(1);
    } finally { runtime.stop(); }
  });

  it("owns Scene graph spawns and nested streams until the parent instance unloads", async () => {
    const child = { ...createDefaultScene(), name: "Child", actors: [marker("nested", 0, "leaf")] };
    const { runtime, world, left } = await setup({ child, deferred: false,
      scenes: { leaf: { ...createDefaultScene(), actors: [createActor("leaf-actor", "Leaf")] } },
      scripts: [logic("Spawned"), logic(sceneAssetClassId("child"), "Scene", 'ctx.spawnActor("Spawned"); ctx.self.setVariable("sceneReference", ctx.getSceneReference());')] });
    try {
      await runtime.loadSceneStream(left);
      const spawned = world.getActors().find((actor) => actor.classId === "Spawned")!;
      expect(spawned).toBeDefined();
      expect(spawned.getVariable("parentId")).toBe("left");
      const nested = world.getActors().find((actor) => actor.guid !== "left" && actor.guid !== "right" && actor.classId === "SceneStreamingActor")!;
      await runtime.loadSceneStream(nested);
      const leaf = world.getActors().find((actor) => actor.getVariable("parentId") === nested.guid)!;
      expect(leaf).toBeDefined();
      await runtime.unloadSceneStream(left);
      expect(spawned.destroyed).toBe(true);
      expect(nested.destroyed).toBe(true);
      expect(leaf.destroyed).toBe(true);
      expect(world.getActors()).toHaveLength(3);
    } finally { runtime.stop(); }
  });

  it("rejects invalid targets and incompatible physics before mutating the parent", async () => {
    const child = { ...createDefaultScene("2d"), actors: [] };
    const { runtime, world, left } = await setup({ child });
    try {
      await expect(runtime.loadSceneStream(null)).rejects.toThrow("Target");
      await expect(runtime.loadSceneStream(left)).rejects.toThrow("Physics World");
      expect(runtime.getSceneState(left)).toBe("Unloaded");
      expect(world.getActors()).toHaveLength(3);
    } finally { runtime.stop(); }
  });

  it("does not resume or spawn from a destroyed caller after a sibling blocking load completes", async () => {
    const caller: CompiledScript = { classId: "ChildActor", parentClassId: "Actor", assetGuid: "caller", anchors: [],
      source: `export async function begin(ctx) {
        if (ctx.self.getVariable("parentId") !== "left") return;
        const target = ctx.getAllActorsOfClass("SceneStreamingActor").find(actor => actor.guid === "right");
        await ctx.loadSceneBlocking(target);
        ctx.setVariable("continued", true);
        ctx.spawnActor("Spawned");
      }
      export function end(ctx) { ctx.spawnActor("Spawned"); }`,
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }, { name: "end", event: "onDestroyed", isAsync: false }] };
    const { runtime, commands, world, left } = await setup({ scripts: [logic("Spawned"), caller] });
    try {
      const first = runtime.loadSceneStream(left);
      acknowledge(runtime, await realized(commands, "left"));
      await first;
      const waiting = world.getActors().find((actor) => actor.classId === "ChildActor" && actor.getVariable("parentId") === "left")!;
      const sibling = await realized(commands, "right");
      await runtime.unloadSceneStream(left);
      expect(waiting.destroyed).toBe(true);
      acknowledge(runtime, sibling);
      await vi.waitFor(() => expect(runtime.getDiagnostics().entries().some((entry) => entry.message.includes("cancelled"))).toBe(true));
      expect(waiting.getVariable("continued")).toBeUndefined();
      expect(world.getActors().some((actor) => actor.classId === "Spawned")).toBe(false);
    } finally { runtime.stop(); }
  });

  it("releases a blocking lease and rolls back only the stream when native physics admission fails", async () => {
    const { runtime, commands, world, left } = await setup();
    try {
      const loading = runtime.loadSceneStream(left, true);
      const failure = expect(loading).rejects.toThrow("Body allocation failed");
      const ready = await realized(commands, "left");
      vi.spyOn(runtime.getPhysicsSync()!.getBackend(), "createBody").mockImplementationOnce(() => { throw new Error("Body allocation failed"); });
      expect(() => acknowledge(runtime, ready)).not.toThrow();
      await failure;
      expect(runtime.getSceneState(left)).toBe("Unloaded");
      expect(runtime.getSceneLoadProgress(left)).toBe(0);
      expect(world.getActors().map((actor) => actor.guid)).toEqual(["left", "right", "authored"]);
      runtime.tick();
      expect(world.clock.tickIndex).toBe(1);
    } finally { runtime.stop(); }
  });

  it("preserves ordinary Actor On Destroyed spawning outside a streamed instance", async () => {
    const death: CompiledScript = { classId: "Parent", parentClassId: "Actor", assetGuid: "death", anchors: [],
      source: 'export function end(ctx) { ctx.spawnActor("Spawned"); }',
      entryPoints: [{ name: "end", event: "onDestroyed", isAsync: false }] };
    const { runtime, world } = await setup({ scripts: [logic("Spawned"), death] });
    try {
      world.destroyActor("authored");
      runtime.tick();
      expect(world.findActor("authored")).toBeUndefined();
      expect(world.getActors().filter((actor) => actor.classId === "Spawned")).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it("holds nested scene publication and scripts until its containing stream is ready", async () => {
    const child = { ...createDefaultScene(), actors: [marker("nested", 0, "leaf")] };
    const { runtime, commands, world, left } = await setup({ child,
      scenes: { leaf: { ...createDefaultScene(), actors: [createActor("leaf", "Leaf", { classId: "ChildActor" })] } } });
    try {
      const outerLoad = runtime.loadSceneStream(left);
      const outerReady = await realized(commands, "left");
      const nested = world.getActors().find((actor) => actor.getVariable("parentId") === "left")!;
      const innerLoad = runtime.loadSceneStream(nested);
      await vi.waitFor(() => expect(world.getActors().some((actor) => actor.classId === "ChildActor")).toBe(true));
      expect(commands.some((command) => command.type === "sceneStreamRealized" && command.actorGuid === nested.guid)).toBe(false);
      runtime.tick();
      const leaf = world.getActors().find((actor) => actor.classId === "ChildActor")!;
      expect(leaf.getVariable("began")).toBeUndefined();
      expect(leaf.getVariable("ticks")).toBeUndefined();
      acknowledge(runtime, outerReady);
      await outerLoad;
      acknowledge(runtime, await realized(commands, nested.guid));
      await innerLoad;
      runtime.tick();
      expect(leaf.getVariable("began")).toBe(true);
      expect(leaf.getVariable("ticks")).toBe(1);
    } finally { runtime.stop(); }
  });

  it("suspends loaded nested actors immediately while the containing async unload yields", async () => {
    let hold = false;
    let release: (() => void) | undefined;
    const child = { ...createDefaultScene(), actors: [
      ...Array.from({ length: 40 }, (_, index) => createActor(`filler-${index}`, "Filler")),
      marker("nested", 0, "leaf"),
    ] };
    const { runtime, world, left } = await setup({ child, deferred: false,
      scenes: { leaf: { ...createDefaultScene(), actors: [createActor("leaf", "Leaf", { classId: "ChildActor" })] } },
      yieldControl: async () => { if (hold) await new Promise<void>((resolve) => { release = resolve; }); } });
    try {
      await runtime.loadSceneStream(left);
      const nested = world.getActors().find((actor) => actor.classId === "SceneStreamingActor" && actor.guid !== "left" && actor.guid !== "right")!;
      await runtime.loadSceneStream(nested);
      const leaf = world.getActors().find((actor) => actor.classId === "ChildActor")!;
      runtime.tick();
      expect(leaf.getVariable("ticks")).toBe(1);
      hold = true;
      const unloading = runtime.unloadSceneStream(left);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(nested.destroyed).toBe(false);
      runtime.tick();
      expect(world.findActor("authored")!.getVariable("ticks")).toBe(2);
      expect(leaf.getVariable("ticks")).toBe(1);
      hold = false;
      release!();
      await unloading;
      expect(leaf.destroyed).toBe(true);
    } finally { hold = false; release?.(); runtime.stop(); }
  });
});
