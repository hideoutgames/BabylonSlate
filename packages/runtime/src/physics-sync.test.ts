import { describe, expect, it } from "vitest";
import {
  applyTexturePixelSizesToSpriteAnimation,
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
  type TilemapPayload,
} from "@babylonslate/assets";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

function createWorld() {
  return new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
}

function spawnBoxActor(
  world: World,
  options: {
    guid: string;
    motionType: "static" | "kinematic" | "dynamic";
    position?: { x: number; y: number; z: number };
  },
) {
  const actor = world.createActor({
    classId: "Actor",
    guid: options.guid,
    transform: {
      ...identityTransform(),
      position: options.position ?? { x: 0, y: 0, z: 0 },
    },
  });
  actor.attachComponent(
    world.createComponent({
      classId: "RigidBodyComponent",
      guid: `${options.guid}-rb`,
      variables: {
        motionType: options.motionType,
        mass: options.motionType === "dynamic" ? 1 : 0,
        gravityScale: 0,
      },
    }),
  );
  actor.attachComponent(
    world.createComponent({
      classId: "ColliderComponent",
      guid: `${options.guid}-col`,
      variables: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      },
    }),
  );
  world.spawnActorNow(actor);
  return actor;
}

function collisionTilemap(): TilemapPayload {
  let tilemap = createDefaultTilemapPayload();
  tilemap = {
    ...tilemap,
    tilesetGuid: "tileset-1",
    tileWidth: 16,
    tileHeight: 16,
  };
  return setTile(tilemap, "layer-1", 0, 0, 1);
}

describe("PhysicsWorldSync collider translation", () => {
  it("passes the collider component local position into the backend", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    const collider = world.createComponent({
      classId: "ColliderComponent",
      guid: "col",
      variables: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      },
      transform: {
        position: { x: 3, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(collider);
    world.spawnActorNow(actor);

    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 3, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "hero",
    );
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).actorIds).toEqual([]);
    sync.dispose();
  });

  it("bakes actor and component scale into collider half-extents", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: {
        ...identityTransform(),
        scale: { x: 2, y: 2, z: 2 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 2, z: 1 },
        },
      }),
    );
    world.spawnActorNow(actor);

    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 0.9, y: 0, z: 0 }, 0.05).actorIds).toContain(
      "hero",
    );
    expect(backend.sphereOverlap({ x: 0, y: 1.9, z: 0 }, 0.05).actorIds).toContain(
      "hero",
    );
    expect(backend.sphereOverlap({ x: 1.2, y: 0, z: 0 }, 0.05).actorIds).toEqual([]);
    sync.dispose();
  });

  it("passes collider component rotation and scaled local translation", () => {
    const yaw90 = Math.SQRT1_2;
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: {
        ...identityTransform(),
        scale: { x: 2, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
        transform: {
          position: { x: 1, y: 0, z: 0 },
          rotation: { x: 0, y: yaw90, z: 0, w: yaw90 },
          scale: { x: 1, y: 1, z: 1 },
        },
      }),
    );
    world.spawnActorNow(actor);

    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 2.3, y: 0, z: 0 }, 0.05).actorIds).toContain(
      "hero",
    );
    expect(backend.sphereOverlap({ x: 0.7, y: 0, z: 0 }, 0.05).actorIds).toEqual(
      [],
    );
    sync.dispose();
  });
});

describe("PhysicsWorldSync destroy and transform ownership", () => {
  it("destroys the backend body after the actor is flushed from the world", () => {
    const world = createWorld();
    spawnBoxActor(world, { guid: "hero", motionType: "static" });
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "hero",
    );

    world.destroyActor("hero");
    world.flushPending();
    sync.syncFromWorld(world);

    expect(backend.getBodyTransform("body:hero")).toBeNull();
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).actorIds).toEqual([]);
    sync.dispose();
  });

  it("copies static actor transforms into the backend on resync", () => {
    const world = createWorld();
    const actor = spawnBoxActor(world, { guid: "wall", motionType: "static" });
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    actor.transform.position.x = 4;
    sync.syncFromWorld(world);

    expect(backend.getBodyTransform("body:wall")?.position.x).toBe(4);
    expect(backend.sphereOverlap({ x: 4, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "wall",
    );
    sync.dispose();
  });

  it("does not overwrite a dynamic body from the actor transform on resync", () => {
    const world = createWorld();
    const actor = spawnBoxActor(world, { guid: "ball", motionType: "dynamic" });
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    actor.transform.position.x = 8;
    sync.syncFromWorld(world);

    expect(backend.getBodyTransform("body:ball")?.position.x).toBe(0);
    sync.dispose();
  });

  it("no-ops addImpulse when the actor has no body", () => {
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    expect(() =>
      sync.addImpulse("missing", { x: 10, y: 0, z: 0 }),
    ).not.toThrow();
    sync.dispose();
  });

  it("applies addImpulse to a dynamic body so a later step moves it", () => {
    const world = createWorld();
    spawnBoxActor(world, { guid: "ball", motionType: "dynamic" });
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);
    sync.addImpulse("ball", { x: 60, y: 0, z: 0 }, 1);
    backend.step(1 / 60);
    expect(backend.getBodyTransform("body:ball")?.position.x).toBeGreaterThan(0);
    sync.dispose();
  });
});

describe("PhysicsWorldSync tilemap colliders", () => {
  const tileset = normalizeTilesetPayload({
    tileWidth: 16,
    tileHeight: 16,
    tiles: [{ id: 1, collision: "full" }],
  });

  it("skips layers with collision false so decorative tiles do not block", () => {
    let tilemap = collisionTilemap();
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({ ...layer, collision: false })),
    };
    const world = createWorld();
    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: identityTransform(),
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setTileContent({
      tilemaps: { "map-1": tilemap },
      tilesets: { "tileset-1": tileset },
      pixelsPerUnit: 16,
    });
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 0.5, y: 0.5, z: 0 }, 0.2).actorIds).toEqual(
      [],
    );
    sync.dispose();
  });

  it("creates chain colliders for collision layers when tile content is present", () => {
    const world = createWorld();
    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: identityTransform(),
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setTileContent({
      tilemaps: new Map([["map-1", collisionTilemap()]]),
      tilesets: new Map([["tileset-1", tileset]]),
      pixelsPerUnit: 16,
    });
    sync.syncFromWorld(world);

    expect(
      backend.sphereOverlap({ x: 0.5, y: 0.5, z: 0 }, 0.2).actorIds,
    ).toContain("ground");
    sync.dispose();
  });

  it("does not emit tilemap colliders when the asset guid is missing", () => {
    const world = createWorld();
    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: identityTransform(),
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
      }),
    );
    world.spawnActorNow(ground);

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setTileContent({
      tilemaps: { "map-1": collisionTilemap() },
      tilesets: { "tileset-1": tileset },
      pixelsPerUnit: 16,
    });
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 0.5, y: 0.5, z: 0 }, 0.2).actorIds).toEqual(
      [],
    );
    sync.dispose();
  });

  it("does not emit tilemap colliders when the tileset payload is missing", () => {
    const world = createWorld();
    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: identityTransform(),
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setTileContent({
      tilemaps: { "map-1": collisionTilemap() },
      tilesets: {},
      pixelsPerUnit: 16,
    });
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 0.5, y: 0.5, z: 0 }, 0.2).actorIds).toEqual(
      [],
    );
    sync.dispose();
  });

  it("ignores a non-positive pixelsPerUnit so existing scale stays in world units", () => {
    const world = createWorld();
    const ground = world.createActor({
      guid: "ground",
      classId: "Actor",
      transform: identityTransform(),
    });
    ground.attachComponent(
      world.createComponent({
        classId: "TilemapComponent",
        assetGuid: "map-1",
        variables: { assetGuid: "map-1" },
      }),
    );
    world.spawnActorNow(ground);

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setTileContent({
      tilemaps: { "map-1": collisionTilemap() },
      tilesets: { "tileset-1": tileset },
      pixelsPerUnit: 16,
    });
    sync.setTileContent({
      tilemaps: { "map-1": collisionTilemap() },
      tilesets: { "tileset-1": tileset },
      pixelsPerUnit: 0,
    });
    sync.syncFromWorld(world);

    expect(
      backend.sphereOverlap({ x: 0.5, y: 0.5, z: 0 }, 0.2).actorIds,
    ).toContain("ground");
    sync.dispose();
  });
});

describe("PhysicsWorldSync sprite collision", () => {
  it("maps the current Sprite Animation frame AABB onto a box2d collider", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "SpriteComponent",
        guid: "spr",
        assetGuid: "hero-sprite",
        variables: { assetGuid: "hero-sprite" },
      }),
    );
    world.spawnActorNow(actor);

    const sprite = createDefaultSpritePayload();
    sprite.pixelsPerUnit = 100;
    sprite.frames[0]!.width = 100;
    sprite.frames[0]!.height = 100;
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0] = {
      textureGuid: "tex-walk",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0.5, y: 0, width: 0.5, height: 1 },
      width: 100,
      height: 100,
    };

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setSpriteContent({
      sprites: new Map([["hero-sprite", sprite]]),
      spriteAnimations: new Map([["walk-anim", animation]]),
      pixelsPerUnit: 100,
    });
    sync.setActorSpriteClip("hero", {
      assetGuid: "walk-anim",
      clipName: "",
      normalisedTime: 0,
    });
    sync.syncFromWorld(world);

    expect(
      backend.sphereOverlap({ x: 0.25, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    expect(
      backend.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
    ).toEqual([]);
    sync.dispose();
  });

  it("does not override a circle collider with the sprite AABB", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "circle", radius: 0.1 },
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "SpriteComponent",
        guid: "spr",
        assetGuid: "hero-sprite",
        variables: { assetGuid: "hero-sprite" },
      }),
    );
    world.spawnActorNow(actor);

    const sprite = createDefaultSpritePayload();
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0]!.collision = { x: 0.5, y: 0, width: 0.5, height: 1 };
    animation.frames[0]!.width = 100;
    animation.frames[0]!.height = 100;

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setSpriteContent({
      sprites: new Map([["hero-sprite", sprite]]),
      spriteAnimations: new Map([["walk-anim", animation]]),
    });
    sync.setActorSpriteClip("hero", {
      assetGuid: "walk-anim",
      clipName: "",
      normalisedTime: 0,
    });
    sync.syncFromWorld(world);

    expect(
      backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    expect(
      backend.sphereOverlap({ x: 0.25, y: 0, z: 0 }, 0.02).actorIds,
    ).toEqual([]);
    sync.dispose();
  });

  it("maps AABB using texture pixel size when the frame omits width and height", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "SpriteComponent",
        guid: "spr",
        assetGuid: "hero-sprite",
        variables: { assetGuid: "hero-sprite" },
      }),
    );
    world.spawnActorNow(actor);

    const sprite = createDefaultSpritePayload();
    sprite.pixelsPerUnit = 100;
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0] = {
      textureGuid: "tex-walk",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
    };
    const sized = applyTexturePixelSizesToSpriteAnimation(
      animation,
      (guid) => (guid === "tex-walk" ? { width: 200, height: 50 } : null),
    );

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setSpriteContent({
      sprites: new Map([["hero-sprite", sprite]]),
      spriteAnimations: new Map([["walk-anim", sized]]),
      pixelsPerUnit: 100,
    });
    sync.setActorSpriteClip("hero", {
      assetGuid: "walk-anim",
      clipName: "",
      normalisedTime: 0,
    });
    sync.syncFromWorld(world);

    expect(
      backend.sphereOverlap({ x: 0.9, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    expect(
      backend.sphereOverlap({ x: 0, y: 0.4, z: 0 }, 0.05).actorIds,
    ).toEqual([]);
    sync.dispose();
  });

  it("restores the Sprite default AABB after the graph leaves a sprite clip", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: "col",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "SpriteComponent",
        guid: "spr",
        assetGuid: "hero-sprite",
        variables: { assetGuid: "hero-sprite" },
      }),
    );
    world.spawnActorNow(actor);

    const sprite = createDefaultSpritePayload();
    sprite.pixelsPerUnit = 100;
    sprite.frames[0]!.width = 100;
    sprite.frames[0]!.height = 100;
    sprite.frames[0]!.collision = { x: 0, y: 0, width: 1, height: 1 };
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0] = {
      textureGuid: "tex-walk",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0.5, y: 0, width: 0.5, height: 1 },
      width: 100,
      height: 100,
    };

    const backend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.setSpriteContent({
      sprites: new Map([["hero-sprite", sprite]]),
      spriteAnimations: new Map([["walk-anim", animation]]),
      pixelsPerUnit: 100,
    });
    sync.setActorSpriteClip("hero", {
      assetGuid: "walk-anim",
      clipName: "",
      normalisedTime: 0,
    });
    sync.syncFromWorld(world);
    expect(
      backend.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
    ).toEqual([]);

    sync.setActorSpriteClip("hero", null);
    sync.syncFromWorld(world);
    expect(
      backend.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    sync.dispose();
  });
});

describe("PhysicsWorldSync blocking volume", () => {
  it("creates a static box collider from actor TRS without a RigidBody", () => {
    const world = createWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "wall",
      transform: {
        ...identityTransform(),
        position: { x: 2, y: 0, z: 0 },
        scale: { x: 4, y: 2, z: 2 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "BlockingVolumeComponent",
        guid: "vol",
        variables: {},
      }),
    );
    world.spawnActorNow(actor);

    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 2, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "wall",
    );
    expect(backend.sphereOverlap({ x: 5, y: 0, z: 0 }, 0.2).actorIds).toEqual([]);
    sync.dispose();
  });

  it("skips overlay-tagged actors when actorFilter excludes them", () => {
    const world = createWorld();
    spawnBoxActor(world, {
      guid: "world-box",
      motionType: "static",
      position: { x: 0, y: 0, z: 0 },
    });
    const overlay = spawnBoxActor(world, {
      guid: "overlay-box",
      motionType: "static",
      position: { x: 10, y: 0, z: 0 },
    });
    overlay.sceneLayerId = "hud";
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId == null,
    });
    sync.syncFromWorld(world);
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "world-box",
    );
    expect(backend.sphereOverlap({ x: 10, y: 0, z: 0 }, 0.2).actorIds).toEqual([]);
    sync.dispose();
  });
});

describe("PhysicsWorldSync live component updates", () => {
  it("applyComponent mass changes how far an impulse moves the body", () => {
    const world = createWorld();
    const actor = spawnBoxActor(world, {
      guid: "hero",
      motionType: "dynamic",
    });
    const rigid = actor.components.find(
      (component) => component.classId === "RigidBodyComponent",
    )!;
    rigid.setVariable("gravityScale", 0);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);
    rigid.setVariable("mass", 10);
    sync.applyComponent(rigid);
    sync.addImpulse("hero", { x: 10, y: 0, z: 0 }, 1);
    backend.step(1 / 60);
    const transform = backend.getBodyTransform("body:hero");
    expect(transform!.position.x).toBeCloseTo(1 / 60, 5);
    sync.dispose();
  });

  it("applyComponent isTrigger flips a blocking overlap to a trigger begin", () => {
    const world = createWorld();
    spawnBoxActor(world, { guid: "a", motionType: "static" });
    const other = spawnBoxActor(world, {
      guid: "b",
      motionType: "static",
      position: { x: 0.25, y: 0, z: 0 },
    });
    const collider = other.components.find(
      (component) => component.classId === "ColliderComponent",
    )!;
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);
    expect(backend.pollContacts().map((event) => event.kind)).toEqual(["hit"]);
    collider.setVariable("isTrigger", true);
    sync.applyComponent(collider);
    expect(backend.pollContacts().map((event) => event.kind)).toEqual([
      "overlapBegin",
    ]);
    sync.dispose();
  });
});
