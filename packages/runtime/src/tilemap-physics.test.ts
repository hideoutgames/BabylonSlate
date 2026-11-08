import { describe, expect, it } from "vitest";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
  TERRAIN_E,
  TERRAIN_W,
  type TilemapPayload,
} from "@haptic/assets";
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
      tilesets: [{ guid: "tileset-1", firstGid: 1, tileCount: 1 }],
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

  it("merges a collision floor that crosses a chunk border into one chain", () => {
    const tileset = normalizeTilesetPayload({ tileWidth: 16, tileHeight: 16, tiles: [{ id: 1, collision: "full" }] });
    let tilemap = {
      ...createDefaultTilemapPayload(),
      tilesets: [{ guid: "tileset-1", firstGid: 1, tileCount: 1 }],
      tileWidth: 16,
      tileHeight: 16,
    };
    const border = tilemap.chunkSize;
    for (let x = border - 2; x < border + 2; x++) tilemap = setTile(tilemap, "layer-1", x, 0, 1);
    const runtime = createInProcessRuntime({
      seed: 4, maxActors: 8, preferSoftwarePhysics: true, physicsWorld: "2d",
      pixelsPerUnit: 16, tilemaps: { "map-1": tilemap }, tilesets: { "tileset-1": tileset },
    });
    const world = runtime.getWorld();
    const ground = world.createActor({ guid: "ground", classId: "Actor" });
    ground.attachComponent(world.createComponent({ classId: "TilemapComponent", assetGuid: "map-1", variables: { assetGuid: "map-1" } }));
    world.spawnActorNow(ground);
    runtime.start();
    runtime.tick();
    const chains = runtime.getPhysicsSync()!.getBackend().listDebugColliders()
      .filter((collider) => collider.id.startsWith("tilemap:"));
    // A chain per chunk would leave an edge at the border for bodies to catch on.
    expect(chains).toHaveLength(1);
    runtime.stop();
  });

  it("puts an unbounded map's floor around its pivot, at negative cells too", () => {
    const tileset = normalizeTilesetPayload({ tileWidth: 16, tileHeight: 16, tiles: [{ id: 1, collision: "full" }] });
    // Cells -4..-1 of row -3, the pivot at map point (-2, -2): the floor spans x -2..2, y -1..0 around the actor.
    let tilemap: TilemapPayload = {
      ...createDefaultTilemapPayload(),
      tilesets: [{ guid: "tileset-1", firstGid: 1, tileCount: 1 }],
      tileWidth: 16,
      tileHeight: 16,
      unbounded: true,
      pivot: { x: -2, y: -2 },
    };
    for (let x = -4; x < 0; x++) tilemap = setTile(tilemap, "layer-1", x, -3, 1);
    const runtime = createInProcessRuntime({
      seed: 4, maxActors: 8, preferSoftwarePhysics: true, physicsWorld: "2d",
      pixelsPerUnit: 16, tilemaps: { "map-1": tilemap }, tilesets: { "tileset-1": tileset },
    });
    const world = runtime.getWorld();
    const ground = world.createActor({ guid: "ground", classId: "Actor" });
    ground.attachComponent(world.createComponent({ classId: "TilemapComponent", assetGuid: "map-1", variables: { assetGuid: "map-1" } }));
    world.spawnActorNow(ground);
    // Right of the cells' own columns: it lands only on the floor the pivot moved under it.
    const box = world.createActor({ guid: "box", classId: "Actor", transform: { position: { x: 1, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } });
    box.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "dynamic", mass: 1, gravityScale: 1 } }));
    box.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } } } }));
    world.spawnActorNow(box);
    runtime.start();
    for (let i = 0; i < 120; i++) runtime.tick();
    expect(box.transform.position.y).toBeGreaterThan(0.2);
    expect(box.transform.position.y).toBeLessThan(0.6);
    runtime.stop();
  });

  it("collides with a map's autotile cells as its current Tileset resolves them", () => {
    // A ground row saved as single pieces (tile 1) before the Tileset had a joined piece (tile 2).
    const groundTileset = (solid: 1 | 2) => normalizeTilesetPayload({
      atlasWidth: 32,
      tileWidth: 16,
      tileHeight: 16,
      terrains: [{ id: "ground", name: "Ground", style: "sides" }],
      tiles: [
        { id: 1, collision: solid === 1 ? "full" : "none", terrain: { id: "ground", mask: 0 } },
        { id: 2, collision: solid === 2 ? "full" : "none", terrain: { id: "ground", mask: TERRAIN_E | TERRAIN_W } },
      ],
    });
    let tilemap: TilemapPayload = {
      ...createDefaultTilemapPayload(),
      tilesets: [{ guid: "tileset-1", firstGid: 1, tileCount: 2 }],
      tileWidth: 16,
      tileHeight: 16,
      width: 4,
      height: 1,
    };
    for (let x = 0; x < 4; x++) tilemap = setTile(tilemap, "layer-1", x, 0, 1);
    const runtime = createInProcessRuntime({
      seed: 4, maxActors: 8, preferSoftwarePhysics: true, physicsWorld: "2d",
      pixelsPerUnit: 16, tilemaps: { "map-1": tilemap }, tilesets: { "tileset-1": groundTileset(2) },
    });
    const world = runtime.getWorld();
    const ground = world.createActor({ guid: "ground", classId: "Actor" });
    ground.attachComponent(world.createComponent({ classId: "TilemapComponent", assetGuid: "map-1", variables: { assetGuid: "map-1" } }));
    world.spawnActorNow(ground);
    const chains = () => runtime.getPhysicsSync()!.getBackend().listDebugColliders()
      .filter((collider) => collider.id.startsWith("tilemap:"));
    runtime.start();
    runtime.tick();
    // The row resolves to the solid joined piece, though the map stores the hollow single piece.
    expect(chains()).toHaveLength(1);
    // Content loaded later resolves the same way: the stored single piece is solid, the joined piece is not.
    runtime.registerTileContent({ tilemaps: { "map-1": tilemap }, tilesets: { "tileset-1": groundTileset(1) }, pixelsPerUnit: 16 });
    runtime.tick();
    expect(chains()).toHaveLength(0);
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
      tilesets: [{ guid: "tileset-1", firstGid: 1, tileCount: 1 }],
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
