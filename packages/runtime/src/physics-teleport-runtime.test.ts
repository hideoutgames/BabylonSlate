import { expect, it } from "vitest";
import { createActor, createDefaultSceneLayer, createDefaultSceneSettings } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const script: CompiledScript = {
  assetGuid: "teleport-script",
  classId: "Teleporter",
  parentClassId: "Actor",
  anchors: [],
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
    "export function move(ctx) { ctx.moveCharacter(ctx.self, { x: 2, y: 0, z: 0 }); }",
  ].join("\n"),
  entryPoints: [
    { name: "teleport", event: "Teleport", isAsync: false },
    { name: "reset", event: "Reset", isAsync: false },
    { name: "move", event: "Move", isAsync: false },
  ],
};

it("publishes gameplay pose writes to real Havok before a same-event query and preserves or resets velocity", async () => {
  const runtime = createInProcessRuntime({
    seed: 1,
    seedDemoActors: false,
    gravity: [0, 0, 0],
  });
  try {
    await runtime.loadScripts([script]);
    const actor = runtime.spawnScriptedActor({ classId: "Teleporter" })!;
    const world = runtime.getWorld();
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: {
          motionType: "dynamic",
          mass: 1,
          gravityScale: 0,
          linearDamping: 0,
          angularDamping: 0,
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
      }),
    );
    await runtime.loadPhysics();
    const sync = runtime.getPhysicsSync()!;
    sync.addImpulse(actor.guid, { x: 6, y: 0, z: 0 });
    runtime.invokeScriptEvent("Teleporter", "Teleport", actor);
    expect(runtime.getDiagnostics().entries()).toEqual([]);
    expect(actor.getVariable("immediateHit")).toBe(true);
    expect(
      sync.lineTrace({ x: 0, y: 2, z: 0 }, { x: 0, y: -2, z: 0 }).hit,
    ).toBe(false);
    sync.step(1 / 60, world);
    expect(actor.transform.position.x).toBeCloseTo(8.1, 2);
    expect(actor.transform.rotation.w).toBeCloseTo(1);

    runtime.invokeScriptEvent("Teleporter", "Reset", actor);
    expect(runtime.getDiagnostics().entries()).toEqual([]);
    expect(actor.transform.position.x).toBe(12);
    expect(
      sync.getBackend().getBodyTransform(`body:${actor.guid}`)!.position.x,
    ).toBe(12);
    expect(
      sync.lineTrace({ x: 12, y: 2, z: 0 }, { x: 12, y: -2, z: 0 }).actorId,
    ).toBe(actor.guid);
    sync.step(1 / 60, world);
    expect(actor.transform.position.x).toBeCloseTo(12);
  } finally {
    runtime.stop();
  }
});

it("routes a SceneLayer gameplay pose write to its layer's physics world", async () => {
  const layer = {
    ...createDefaultSceneLayer(),
    settings: { ...createDefaultSceneLayer().settings, physicsEnabled: true },
    actors: [
      createActor("overlay-body", "Overlay Body", {
        classId: "Teleporter",
        components: [
          {
            id: "rigid",
            classId: "RigidBodyComponent",
            properties: {
              motionType: "dynamic",
              mass: 1,
              gravityScale: 0,
              linearDamping: 0,
              angularDamping: 0,
            },
          },
          {
            id: "collider",
            classId: "ColliderComponent",
            properties: {
              shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
            },
          },
        ],
      }),
    ],
  };
  const runtime = createInProcessRuntime({
    seed: 1,
    seedDemoActors: false,
    preferSoftwarePhysics: true,
    sceneLayerLibrary: { overlay: layer },
  });
  try {
    await runtime.loadScripts([script]);
    const sceneLayer = runtime.createSceneLayer("overlay")!;
    const world = runtime.getWorld();
    const actor = world
      .getActors()
      .find((entry) => entry.classId === "Teleporter")!;
    expect(actor.sceneLayerId).toBeTruthy();
    const overlay = runtime.getSceneLayerPhysicsSync(sceneLayer.guid)!;
    overlay.syncFromWorld(world);
    runtime.invokeScriptEvent("Teleporter", "Teleport", actor);
    expect(
      overlay.lineTrace({ x: 8, y: 2, z: 0 }, { x: 8, y: -2, z: 0 }).actorId,
    ).toBe(actor.guid);
    expect(
      overlay.lineTrace({ x: 0, y: 2, z: 0 }, { x: 0, y: -2, z: 0 }).hit,
    ).toBe(false);
    expect(
      runtime
        .getPhysicsSync()!
        .getBackend()
        .getBodyTransform(`body:${actor.guid}`),
    ).toBeNull();
    runtime.invokeScriptEvent("Teleporter", "Move", actor);
    expect(runtime.getDiagnostics().entries()).toEqual([]);
    expect(actor.transform.position.x).toBeCloseTo(10);
    expect(
      overlay.getBackend().getBodyTransform(`body:${actor.guid}`)!.position.x,
    ).toBeCloseTo(10);
    expect(
      runtime
        .getPhysicsSync()!
        .getBackend()
        .getBodyTransform(`body:${actor.guid}`),
    ).toBeNull();
  } finally {
    runtime.stop();
  }
});

it("places a parented body and converts Move Character against its parent's pose at call time", async () => {
  const rider: CompiledScript = {
    assetGuid: "rider-script",
    classId: "Rider",
    parentClassId: "Actor",
    anchors: [],
    source: [
      "export function ride(ctx) {",
      "  const carrier = ctx.getParent(ctx.self);",
      // A quarter turn about +Y maps local +X to world -Z.
      "  ctx.setActorTransform(carrier, { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } });",
      "  ctx.setActorLocation(ctx.self, { x: 1, y: 0, z: 0 });",
      "  ctx.setVariable('placed', ctx.lineTrace({ x: 10, y: 2, z: -1 }, { x: 10, y: -2, z: -1 }, undefined, { drawDebug: false }).actor);",
      "  ctx.moveCharacter(ctx.self, { x: 2, y: 0, z: 0 });",
      "}",
    ].join("\n"),
    entryPoints: [{ name: "ride", event: "Ride", isAsync: false }],
  };
  const runtime = createInProcessRuntime({
    seed: 1,
    seedDemoActors: false,
    preferSoftwarePhysics: true,
    physicsWorld: "3d",
    gravity: [0, 0, 0],
    playScene: {
      name: "Carrier",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("carrier", "Carrier"),
        createActor("rider", "Rider", {
          classId: "Rider",
          parentId: "carrier",
          components: [
            { id: "body", classId: "RigidBodyComponent", properties: { motionType: "kinematic", mass: 1, gravityScale: 0 } },
            { id: "box", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.25, y: 0.25, z: 0.25 } } } },
          ],
        }),
      ],
    },
  });
  try {
    await runtime.loadScripts([rider]);
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    const actor = runtime.getWorld().findActor("rider")!;
    runtime.invokeScriptEvent("Rider", "Ride", actor);
    expect(runtime.getDiagnostics().entries()).toEqual([]);
    // Local (1, 0, 0) under the moved, turned carrier is world (10, 0, -1).
    expect(actor.getVariable("placed")).toBe(actor);
    // The controller moved the body to world (12, 0, -1); relative to the
    // carrier's current pose that is local (1, 0, 2), so world and body agree.
    const body = runtime.getPhysicsSync()!.getBackend().getBodyTransform(`body:${actor.guid}`)!;
    expect(body.position.x).toBeCloseTo(12, 9);
    expect(body.position.z).toBeCloseTo(-1, 9);
    expect(actor.transform.position.x).toBeCloseTo(1, 9);
    expect(actor.transform.position.y).toBeCloseTo(0, 9);
    expect(actor.transform.position.z).toBeCloseTo(2, 9);
    expect(actor.transform.rotation.w).toBeCloseTo(1, 9);
  } finally {
    runtime.stop();
  }
});
