import type { PhysicsBackend, PhysicsTransform, Vec3 } from "@babylonslate/physics";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import type { Actor, World } from "@babylonslate/object-model";
import {
  tilemapChunkChains,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";

/**
 * Keeps `@babylonslate/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent.
 */
export class PhysicsWorldSync {
  private readonly backend: PhysicsBackend;
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private synced = false;
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private pixelsPerUnit = 100;

  constructor(backend: PhysicsBackend) {
    this.backend = backend;
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  setTileContent(options: {
    tilemaps: ReadonlyMap<string, TilemapPayload> | Readonly<Record<string, TilemapPayload>>;
    tilesets: ReadonlyMap<string, TilesetPayload> | Readonly<Record<string, TilesetPayload>>;
    pixelsPerUnit?: number;
  }): void {
    this.tilemaps = toMap(options.tilemaps);
    this.tilesets = toMap(options.tilesets);
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  dispose(): void {
    this.backend.dispose();
    this.bodyByActor.clear();
    this.characterByActor.clear();
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    const live = new Set<string>();
    for (const actor of world.getActors()) {
      if (actor.destroyed) continue;
      const rigid = actor.components.find(
        (c) => c.classId === "RigidBodyComponent" && !c.destroyed,
      );
      const tilemap = actor.components.find(
        (c) => c.classId === "TilemapComponent" && !c.destroyed,
      );
      if (!rigid && !tilemap) continue;
      live.add(actor.guid);
      if (!this.bodyByActor.has(actor.guid)) {
        this.createForActor(actor);
      } else {
        const bodyId = this.bodyByActor.get(actor.guid)!;
        const props = parseRigidBodyProperties(
          rigid ? mapToRecord(rigid.variables) : { motionType: "static" },
        );
        if (props.motionType !== "dynamic") {
          this.backend.setBodyTransform(bodyId, actorTransform(actor));
        }
      }
    }
    for (const [actorId, bodyId] of [...this.bodyByActor]) {
      if (live.has(actorId)) continue;
      this.backend.destroyBody(bodyId);
      this.bodyByActor.delete(actorId);
      this.characterByActor.delete(actorId);
    }
    this.synced = true;
  }

  step(dt: number, world: World): void {
    if (!this.synced) this.syncFromWorld(world);
    else this.syncFromWorld(world);
    this.backend.step(dt);
    for (const [actorId, bodyId] of this.bodyByActor) {
      const actor = world.getActors().find((a) => a.guid === actorId);
      if (!actor || actor.destroyed) continue;
      const transform = this.backend.getBodyTransform(bodyId);
      if (!transform) continue;
      actor.transform.position.x = transform.position.x;
      actor.transform.position.y = transform.position.y;
      actor.transform.position.z = transform.position.z;
      actor.transform.rotation.x = transform.rotation.x;
      actor.transform.rotation.y = transform.rotation.y;
      actor.transform.rotation.z = transform.rotation.z;
      actor.transform.rotation.w = transform.rotation.w;
    }
  }

  lineTrace(start: Vec3, end: Vec3) {
    return this.backend.lineTrace(start, end);
  }

  sphereOverlap(center: Vec3, radius: number) {
    return this.backend.sphereOverlap(center, radius);
  }

  shapeSweep(
    shape: Parameters<PhysicsBackend["shapeSweep"]>[0],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ) {
    return this.backend.shapeSweep(shape, start, end);
  }

  addImpulse(actorId: string, impulse: Vec3, strength?: number): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (!bodyId) return;
    this.backend.addImpulse(bodyId, impulse, strength);
  }

  /**
   * Lazy character controller keyed by actor guid. Applies the resolved
   * transform to the actor immediately so the next kinematic sync keeps it.
   */
  moveCharacter(
    actor: Actor,
    translation: Vec3,
    dt: number,
    offset?: number,
  ): void {
    if (!this.bodyByActor.has(actor.guid)) {
      this.createForActor(actor);
    }
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return;
    if (!this.characterByActor.has(actor.guid)) {
      const skin = offset != null && offset > 0 ? offset : 0.01;
      this.backend.createCharacterController({
        id: actor.guid,
        bodyId,
        offset: skin,
      });
      this.characterByActor.set(actor.guid, actor.guid);
    }
    const moved = this.backend.moveCharacter(actor.guid, translation, dt);
    if (!moved) return;
    actor.transform.position.x = moved.position.x;
    actor.transform.position.y = moved.position.y;
    actor.transform.position.z = moved.position.z;
    actor.transform.rotation.x = moved.rotation.x;
    actor.transform.rotation.y = moved.rotation.y;
    actor.transform.rotation.z = moved.rotation.z;
    actor.transform.rotation.w = moved.rotation.w;
  }

  private createForActor(actor: Actor): void {
    const rigid = actor.components.find(
      (c) => c.classId === "RigidBodyComponent" && !c.destroyed,
    );
    const tilemap = actor.components.find(
      (c) => c.classId === "TilemapComponent" && !c.destroyed,
    );
    if (!rigid && !tilemap) return;
    const bodyId = `body:${actor.guid}`;
    const props = parseRigidBodyProperties(
      rigid ? mapToRecord(rigid.variables) : { motionType: "static", mass: 0, gravityScale: 0 },
    );
    this.backend.createBody({
      id: bodyId,
      actorId: actor.guid,
      motionType: rigid ? props.motionType : "static",
      mass: rigid ? props.mass : 0,
      linearDamping: props.linearDamping,
      angularDamping: props.angularDamping,
      gravityScale: rigid ? props.gravityScale : 0,
      transform: actorTransform(actor),
    });
    this.bodyByActor.set(actor.guid, bodyId);

    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) {
        continue;
      }
      const collider = parseColliderProperties(
        mapToRecord(component.variables),
        this.backend.kind,
      );
      this.backend.createCollider({
        id: `collider:${component.guid}`,
        bodyId,
        shape: collider.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
      });
    }

    if (tilemap) this.createTilemapColliders(actor, bodyId, tilemap);
  }

  private createTilemapColliders(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
  ): void {
    const guid =
      component.assetGuid ??
      (typeof component.getVariable("assetGuid") === "string"
        ? String(component.getVariable("assetGuid"))
        : null);
    if (!guid) return;
    const tilemap = this.tilemaps.get(guid);
    if (!tilemap?.tilesetGuid) return;
    const tileset = this.tilesets.get(tilemap.tilesetGuid);
    if (!tileset) return;
    const ppu = this.pixelsPerUnit > 0 ? this.pixelsPerUnit : 100;
    const worldTileWidth = tilemap.tileWidth / ppu;
    const worldTileHeight = tilemap.tileHeight / ppu;
    let index = 0;
    for (const layer of tilemap.layers) {
      if (!layer.collision) continue;
      for (const chunk of layer.chunks) {
        const chains = tilemapChunkChains({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset,
          worldTileWidth,
          worldTileHeight,
        });
        for (const chain of chains) {
          if (chain.points.length < 2) continue;
          this.backend.createCollider({
            id: `tilemap:${actor.guid}:${layer.id}:${chunk.cx}:${chunk.cy}:${index}`,
            bodyId,
            shape: { kind: "chain", points: chain.points, loop: chain.loop },
            friction: 0.5,
            restitution: 0,
            isTrigger: false,
            layer: 1,
            mask: 0xffffffff,
          });
          index += 1;
        }
      }
    }
  }
}

function actorTransform(actor: Actor): PhysicsTransform {
  return {
    position: {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
      z: actor.transform.position.z,
    },
    rotation: {
      x: actor.transform.rotation.x,
      y: actor.transform.rotation.y,
      z: actor.transform.rotation.z,
      w: actor.transform.rotation.w,
    },
  };
}

function mapToRecord(
  variables: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of variables) out[key] = value;
  return out;
}

function toMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}
