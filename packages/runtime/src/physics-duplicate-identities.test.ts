import { describe, expect, it } from "vitest";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import {
  createActor,
  createDefaultScene,
  type SerializedActor,
  type SerializedComponent,
} from "@babylonslate/core";
import {
  ClassRegistry,
  World,
  createActorsFromSerializedScene,
} from "@babylonslate/object-model";
import {
  createSoftwarePhysicsBackend,
  HavokPhysicsBackend,
} from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

function legacyScene(components: SerializedComponent[]) {
  const scene = createDefaultScene();
  scene.actors = Array.from({ length: 8 }, (_, index) =>
    createActor(`sphere-${index}`, `Sphere ${index + 1}`, {
      transform: {
        position: [index * 2, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      // Older editor versions duplicated these authored IDs verbatim.
      components: structuredClone(components),
    }),
  );
  return scene;
}

const rigid: SerializedComponent = {
  id: "shared-body",
  classId: "RigidBodyComponent",
  properties: { motionType: "static", mass: 0, gravityScale: 0 },
};
const collider: SerializedComponent = {
  id: "shared-collider",
  classId: "ColliderComponent",
  properties: { shape: { kind: "sphere", radius: 0.5 } },
};

describe("physics identities in previously duplicated scenes", () => {
  it.each([
    { name: "explicit", kind: "3d" as const, components: [rigid, collider] },
    {
      name: "mesh",
      kind: "3d" as const,
      components: [
        {
          id: "shared-mesh",
          classId: "MeshComponent",
          properties: { meshKind: "sphere", collisionMode: "simple" },
        },
      ],
    },
    {
      name: "blocking volume",
      kind: "3d" as const,
      components: [
        {
          id: "shared-volume",
          classId: "BlockingVolumeComponent",
          properties: {},
        },
      ],
    },
    {
      name: "sprite frame",
      kind: "2d" as const,
      components: [
        rigid,
        {
          ...collider,
          properties: {
            shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
          },
        },
        {
          id: "shared-sprite",
          classId: "SpriteComponent",
          properties: { assetGuid: "sprite" },
        },
      ],
    },
  ])(
    "keeps every $name collider queryable when another duplicate is destroyed",
    ({ kind, components }) => {
      const world = new World({
        seed: 1,
        dt: 1 / 60,
        classRegistry: new ClassRegistry(),
      });
      const actors = createActorsFromSerializedScene(
        world,
        legacyScene(components),
      );
      for (const actor of actors) world.spawnActorNow(actor);
      const backend = createSoftwarePhysicsBackend(kind, { x: 0, y: 0, z: 0 });
      const sync = new PhysicsWorldSync(backend);
      const sprite = createDefaultSpritePayload();
      sprite.frames[0]!.width = 100;
      sprite.frames[0]!.height = 100;
      sprite.frames[0]!.collision = { x: 0, y: 0, width: 1, height: 1 };
      sync.setSpriteContent({
        sprites: { sprite },
        spriteAnimations: {},
        pixelsPerUnit: 100,
      });
      try {
        sync.syncFromWorld(world);
        for (let index = 0; index < 8; index++) {
          expect(
            backend.sphereOverlap({ x: index * 2, y: 0, z: 0 }, 0.1).actorIds,
          ).toEqual([`sphere-${index}`]);
      }
      world.destroyActor(actors[0]!.guid);
      world.flushPending();
      sync.syncFromWorld(world);
        expect(
          backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1).actorIds,
        ).toEqual([]);
        for (let index = 1; index < 8; index++) {
          expect(
            backend.sphereOverlap({ x: index * 2, y: 0, z: 0 }, 0.1).actorIds,
          ).toEqual([`sphere-${index}`]);
        }
      } finally {
        sync.dispose();
      }
    },
  );

  it("updates only the selected duplicate's trigger state", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const scene = legacyScene([rigid, collider]);
    scene.actors = scene.actors.slice(0, 4);
    scene.actors[1]!.transform.position = [0.4, 0, 0];
    scene.actors[3]!.transform.position = [4.4, 0, 0];
    const actors = createActorsFromSerializedScene(world, scene);
    for (const actor of actors) world.spawnActorNow(actor);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    try {
      sync.syncFromWorld(world);
      expect(backend.pollContacts().map((event) => event.kind)).toEqual([
        "hit",
        "hit",
      ]);
      const selected = actors[0]!.components.find(
        (component) => component.classId === "ColliderComponent",
      )!;
      selected.setVariable("isTrigger", true);
      sync.applyComponent(selected);
      const updated = backend.pollContacts();
      expect(updated).toHaveLength(2);
      expect(updated).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "overlapBegin",
            actorAId: "sphere-0",
            actorBId: "sphere-1",
          }),
          expect.objectContaining({
            kind: "hit",
            actorAId: "sphere-2",
            actorBId: "sphere-3",
          }),
        ]),
      );
      selected.setVariable("isTrigger", false);
      sync.applyComponent(selected);
      expect(backend.pollContacts().map((event) => event.kind).sort()).toEqual([
        "hit",
        "hit",
        "overlapEnd",
      ]);
    } finally {
      sync.dispose();
    }
  });

  it("lets all eight legacy spheres contact and roll down an angled cube with Havok", async () => {
    const scene = legacyScene([
      {
        ...rigid,
        properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
      },
      collider,
    ]);
    for (const [index, actor] of scene.actors.entries()) {
      actor.transform.position = [0, 3, (index - 3.5) * 1.5];
    }
    const angle = Math.PI / 12;
    const ramp: SerializedActor = createActor("ramp", "Ramp", {
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, Math.sin(angle), Math.cos(angle)],
        scale: [14, 1, 16],
      },
      components: [
        {
          id: "ramp-mesh",
          classId: "MeshComponent",
          properties: { meshKind: "box", collisionMode: "simple" },
        },
      ],
    });
    scene.actors.unshift(ramp);
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const actors = createActorsFromSerializedScene(world, scene);
    for (const actor of actors) world.spawnActorNow(actor);
    const backend = await HavokPhysicsBackend.create({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    const sync = new PhysicsWorldSync(backend);
    try {
      sync.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(9);
      const touched = new Set<string>();
      for (let tick = 0; tick < 150; tick++) {
        sync.step(1 / 60, world);
        for (const event of backend.pollContacts()) {
          if (event.actorAId === "ramp") touched.add(event.actorBId);
          if (event.actorBId === "ramp") touched.add(event.actorAId);
        }
      }
      expect(touched.size).toBe(8);
      for (const actor of actors.slice(1)) {
        expect(actor.transform.position.x).toBeLessThan(-1);
        expect(actor.transform.position.y).toBeGreaterThan(-4);
      }
    } finally {
      sync.dispose();
    }
  });
});
