import { expect, it } from "vitest";
import { createActor, createDefaultSceneLayer } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const script: CompiledScript = {
  assetGuid: "teleport-script", classId: "Teleporter", parentClassId: "Actor", anchors: [],
  source: [
    "export function teleport(ctx) {",
    "  ctx.setActorLocation(ctx.self, { x: 4, y: 0, z: 0 });",
    "  ctx.addActorWorldOffset(ctx.self, { x: 1, y: 0, z: 0 });",
    "  ctx.setActorRotation(ctx.self, { pitch: 0, yaw: 90, roll: 0 });",
    "  ctx.setActorScale(ctx.self, { x: 2, y: 2, z: 2 });",
    "  ctx.setActorTransform(ctx.self, { position: { x: 8, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 2 } });",
    "  ctx.setVariable('immediateHit', ctx.lineTrace({ x: 8, y: 2, z: 0 }, { x: 8, y: -2, z: 0 }).hit);",
    "}",
    "export function reset(ctx) {",
    "  ctx.setActorTransform(ctx.self, { position: { x: 12, y: 0, z: 0 } }, { velocity: 'reset' });",
    "}",
  ].join("\n"),
  entryPoints: [
    { name: "teleport", event: "Teleport", isAsync: false },
    { name: "reset", event: "Reset", isAsync: false },
  ],
};

it("publishes gameplay pose writes to real Havok before a same-event query and preserves or resets velocity", async () => {
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, gravity: [0, 0, 0] });
  try {
    await runtime.loadScripts([script]);
    const actor = runtime.spawnScriptedActor({ classId: "Teleporter" })!;
    const world = runtime.getWorld();
    actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: {
      motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0,
    } }));
    actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: {
      shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    } }));
    await runtime.loadPhysics();
    const sync = runtime.getPhysicsSync()!;
    sync.addImpulse(actor.guid, { x: 6, y: 0, z: 0 });
    runtime.invokeScriptEvent("Teleporter", "Teleport", actor);
    expect(runtime.getDiagnostics().entries()).toEqual([]);
    expect(actor.getVariable("immediateHit")).toBe(true);
    expect(sync.lineTrace({ x: 0, y: 2, z: 0 }, { x: 0, y: -2, z: 0 }).hit).toBe(false);
    sync.step(1 / 60, world);
    expect(actor.transform.position.x).toBeCloseTo(8.1, 2);
    expect(actor.transform.rotation.w).toBeCloseTo(1);

    runtime.invokeScriptEvent("Teleporter", "Reset", actor);
    expect(sync.lineTrace({ x: 12, y: 2, z: 0 }, { x: 12, y: -2, z: 0 }).actorId).toBe(actor.guid);
    sync.step(1 / 60, world);
    expect(actor.transform.position.x).toBeCloseTo(12);
  } finally { runtime.stop(); }
});

it("routes a SceneLayer gameplay pose write to its overlay physics owner", async () => {
  const layer = {
    ...createDefaultSceneLayer(),
    actors: [createActor("overlay-body", "Overlay Body", { classId: "Teleporter", components: [
      { id: "rigid", classId: "RigidBodyComponent", properties: {
        motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0,
      } },
      { id: "collider", classId: "ColliderComponent", properties: {
        shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
      } },
    ] })],
  };
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    sceneLayerLibrary: { overlay: layer },
  });
  try {
    await runtime.loadScripts([script]);
    runtime.createSceneLayer("overlay");
    const world = runtime.getWorld();
    const actor = world.getActors().find((entry) => entry.classId === "Teleporter")!;
    expect(actor.sceneLayerId).toBeTruthy();
    const overlay = runtime.getOverlayPhysicsSync()!;
    overlay.syncFromWorld(world);
    runtime.invokeScriptEvent("Teleporter", "Teleport", actor);
    expect(overlay.lineTrace({ x: 8, y: 2, z: 0 }, { x: 8, y: -2, z: 0 }).actorId).toBe(actor.guid);
    expect(overlay.lineTrace({ x: 0, y: 2, z: 0 }, { x: 0, y: -2, z: 0 }).hit).toBe(false);
    expect(runtime.getPhysicsSync()!.getBackend().getBodyTransform(`body:${actor.guid}`)).toBeNull();
  } finally { runtime.stop(); }
});
