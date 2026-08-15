import { describe, expect, it } from "vitest";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
} from "@babylonslate/assets";
import { createInProcessRuntime } from "./driver";

describe("tilemap chain colliders", () => {
  it("gives TilemapComponent a static body whose chains catch a falling actor", () => {
    const tileset = normalizeTilesetPayload({
      tileWidth: 16,
      tileHeight: 16,
      tiles: [{ id: 1, collision: "full" }],
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = {
      ...tilemap,
      tilesetGuid: "tileset-1",
      tileWidth: 16,
      tileHeight: 16,
    };
    for (let x = 0; x < 4; x++) {
      tilemap = setTile(tilemap, "layer-1", x, 0, 1);
    }

    const runtime = createInProcessRuntime({
      seed: 4,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "2d",
      seedDemoActors: false,
      pixelsPerUnit: 16,
      tilemaps: { "map-1": tilemap },
      tilesets: { "tileset-1": tileset },
    });
    const world = runtime.getWorld();

    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const box = world.createActor({
      guid: "box",
      classId: "Actor",
      transform: {
        position: { x: 1, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    box.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "dynamic", mass: 1, gravityScale: 1 },
      }),
    );
    box.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
        },
      }),
    );
    world.spawnActorNow(box);

    runtime.start();
    for (let i = 0; i < 120; i++) runtime.tick();

    expect(box.transform.position.y).toBeLessThan(5);
    expect(box.transform.position.y).toBeGreaterThan(0.5);
    runtime.stop();
  });

  it("Rapier 2D chain colliders catch a falling actor", async () => {
    const tileset = normalizeTilesetPayload({
      tileWidth: 16,
      tileHeight: 16,
      tiles: [{ id: 1, collision: "full" }],
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = {
      ...tilemap,
      tilesetGuid: "tileset-1",
      tileWidth: 16,
      tileHeight: 16,
    };
    for (let x = 0; x < 4; x++) {
      tilemap = setTile(tilemap, "layer-1", x, 0, 1);
    }

    const runtime = createInProcessRuntime({
      seed: 4,
      maxActors: 8,
      physicsWorld: "2d",
      seedDemoActors: false,
      pixelsPerUnit: 16,
      tilemaps: { "map-1": tilemap },
      tilesets: { "tileset-1": tileset },
    });
    const world = runtime.getWorld();

    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const box = world.createActor({
      guid: "box",
      classId: "Actor",
      transform: {
        position: { x: 1, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    box.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "dynamic", mass: 1, gravityScale: 1 },
      }),
    );
    box.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
        },
      }),
    );
    world.spawnActorNow(box);

    await runtime.loadPhysics();
    runtime.start();
    for (let i = 0; i < 120; i++) runtime.tick();

    expect(box.transform.position.y).toBeLessThan(5);
    expect(box.transform.position.y).toBeGreaterThan(0.5);
    runtime.stop();
  });
});
