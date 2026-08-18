import type { PhysicsBackend, PhysicsTransform, Vec3 } from "@babylonslate/physics";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import type { Actor, World } from "@babylonslate/object-model";
import {
  spriteAnimationFrameAt,
  spriteClipFrameAt,
  spriteCollisionToBox2d,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
  tilemapChunkChains,
} from "@babylonslate/assets";
import {
  actorParentGuid,
  actorWorldTransforms,
  inverseQuaternion,
  multiplyQuaternion,
  rotateVector,
  type ActorTransformMap,
} from "./actor-world-transform";

/**
 * Keeps `@babylonslate/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent.
 */
export class PhysicsWorldSync {
  private readonly backend: PhysicsBackend;
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private synced = false;
  private actors: readonly Actor[] = [];
  private worldTransforms: ActorTransformMap = new Map();
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private spriteClipByActor = new Map<
    string,
    { assetGuid: string; clipName: string; normalisedTime: number }
  >();
  private spriteColliderKeyByActor = new Map<string, Map<string, string>>();
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

  setSpriteContent(options: {
    sprites:
      | ReadonlyMap<string, SpritePayload>
      | Readonly<Record<string, SpritePayload>>;
    spriteAnimations:
      | ReadonlyMap<string, SpriteAnimationPayload>
      | Readonly<Record<string, SpriteAnimationPayload>>;
    pixelsPerUnit?: number;
  }): void {
    this.sprites = toMap(options.sprites);
    this.spriteAnimations = toMap(options.spriteAnimations);
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
    this.spriteColliderKeyByActor.clear();
  }

  setActorSpriteClip(
    actorGuid: string,
    clip: {
      assetGuid: string;
      clipName: string;
      normalisedTime: number;
    } | null,
  ): void {
    if (!clip) {
      this.spriteClipByActor.delete(actorGuid);
      return;
    }
    this.spriteClipByActor.set(actorGuid, clip);
  }

  dispose(): void {
    this.backend.dispose();
    this.bodyByActor.clear();
    this.characterByActor.clear();
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    this.actors = world.getActors();
    this.worldTransforms = actorWorldTransforms(this.actors);
    const live = new Set<string>();
    for (const actor of this.actors) {
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
          this.backend.setBodyTransform(
            bodyId,
            actorWorldPhysicsTransform(actor, this.worldTransforms),
          );
        }
        this.applySpriteColliders(actor, bodyId);
      }
    }
    for (const [actorId, bodyId] of [...this.bodyByActor]) {
      if (live.has(actorId)) continue;
      this.backend.destroyBody(bodyId);
      this.bodyByActor.delete(actorId);
      this.characterByActor.delete(actorId);
      this.spriteClipByActor.delete(actorId);
      this.spriteColliderKeyByActor.delete(actorId);
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
      const localTransform = actorLocalPhysicsTransform(
        transform,
        actor,
        this.worldTransforms,
      );
      actor.transform.position.x = localTransform.position.x;
      actor.transform.position.y = localTransform.position.y;
      actor.transform.position.z = localTransform.position.z;
      actor.transform.rotation.x = localTransform.rotation.x;
      actor.transform.rotation.y = localTransform.rotation.y;
      actor.transform.rotation.z = localTransform.rotation.z;
      actor.transform.rotation.w = localTransform.rotation.w;
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
    const localTransform = actorLocalPhysicsTransform(
      moved,
      actor,
      this.worldTransforms,
    );
    actor.transform.position.x = localTransform.position.x;
    actor.transform.position.y = localTransform.position.y;
    actor.transform.position.z = localTransform.position.z;
    actor.transform.rotation.x = localTransform.rotation.x;
    actor.transform.rotation.y = localTransform.rotation.y;
    actor.transform.rotation.z = localTransform.rotation.z;
    actor.transform.rotation.w = localTransform.rotation.w;
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
      transform: actorWorldPhysicsTransform(actor, this.worldTransforms),
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
        translation: {
          x: component.transform.position.x,
          y: component.transform.position.y,
          z: component.transform.position.z,
        },
      });
    }

    if (tilemap) this.createTilemapColliders(actor, bodyId, tilemap);
    this.applySpriteColliders(actor, bodyId);
  }

  private applySpriteColliders(actor: Actor, bodyId: string): void {
    const sprite = actor.components.find(
      (component) => component.classId === "SpriteComponent" && !component.destroyed,
    );
    if (!sprite) return;
    const spriteGuid =
      sprite.assetGuid ??
      (typeof sprite.getVariable("assetGuid") === "string"
        ? String(sprite.getVariable("assetGuid"))
        : "");
    const spritePayload = spriteGuid ? this.sprites.get(spriteGuid) : undefined;
    const playback = this.spriteClipByActor.get(actor.guid);
    const frame = resolveSpriteCollisionFrame({
      sprite: spritePayload,
      animation: playback
        ? this.spriteAnimations.get(playback.assetGuid)
        : undefined,
      playback,
    });
    if (!frame) return;
    const ppu =
      (spritePayload?.pixelsPerUnit && spritePayload.pixelsPerUnit > 0
        ? spritePayload.pixelsPerUnit
        : this.pixelsPerUnit) || 100;
    const mapped = spriteCollisionToBox2d({
      collision: frame.collision,
      pivot: frame.pivot,
      pixelWidth: frame.width ?? 100,
      pixelHeight: frame.height ?? 100,
      pixelsPerUnit: ppu,
    });
    const keys = this.spriteColliderKeyByActor.get(actor.guid) ?? new Map();
    this.spriteColliderKeyByActor.set(actor.guid, keys);
    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) {
        continue;
      }
      const collider = parseColliderProperties(
        mapToRecord(component.variables),
        this.backend.kind,
      );
      if (collider.shape.kind !== "box2d") continue;
      const colliderId = `collider:${component.guid}`;
      const translation = {
        x: component.transform.position.x + mapped.translation.x,
        y: component.transform.position.y + mapped.translation.y,
        z: component.transform.position.z,
      };
      const fingerprint = [
        mapped.halfExtents.x,
        mapped.halfExtents.y,
        translation.x,
        translation.y,
        translation.z,
      ].join(",");
      if (keys.get(colliderId) === fingerprint) continue;
      this.backend.destroyCollider(colliderId);
      this.backend.createCollider({
        id: colliderId,
        bodyId,
        shape: { kind: "box2d", halfExtents: mapped.halfExtents },
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation,
      });
      keys.set(colliderId, fingerprint);
    }
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

function actorWorldPhysicsTransform(
  actor: Actor,
  transforms: ActorTransformMap,
): PhysicsTransform {
  const world = transforms.get(actor.guid) ?? actor.transform;
  return {
    position: { ...world.position },
    rotation: { ...world.rotation },
  };
}

function actorLocalPhysicsTransform(
  world: PhysicsTransform,
  actor: Actor,
  transforms: ActorTransformMap,
): PhysicsTransform {
  const parentId = actorParentGuid(actor);
  const parentWorld = parentId ? transforms.get(parentId) : undefined;
  if (!parentWorld) return world;
  const inverseRotation = inverseQuaternion(parentWorld.rotation);
  const offset = rotateVector(inverseRotation, {
    x: world.position.x - parentWorld.position.x,
    y: world.position.y - parentWorld.position.y,
    z: world.position.z - parentWorld.position.z,
  });
  return {
    position: {
      x: divideScale(offset.x, parentWorld.scale.x),
      y: divideScale(offset.y, parentWorld.scale.y),
      z: divideScale(offset.z, parentWorld.scale.z),
    },
    rotation: multiplyQuaternion(inverseRotation, world.rotation),
  };
}

function resolveSpriteCollisionFrame(options: {
  sprite: SpritePayload | undefined;
  animation: SpriteAnimationPayload | undefined;
  playback:
    | { assetGuid: string; clipName: string; normalisedTime: number }
    | undefined;
}): {
  collision: { x: number; y: number; width: number; height: number };
  pivot: { x: number; y: number };
  width?: number;
  height?: number;
} | null {
  if (options.animation && options.playback) {
    const frame = spriteAnimationFrameAt(
      options.animation,
      options.playback.normalisedTime,
    );
    if (frame) {
      return {
        collision: frame.collision,
        pivot: frame.pivot,
        width: frame.width,
        height: frame.height,
      };
    }
  }
  if (!options.sprite) return null;
  if (options.playback?.clipName) {
    const clipFrame = spriteClipFrameAt(
      options.sprite,
      options.playback.clipName,
      options.playback.normalisedTime,
    );
    if (clipFrame) {
      return {
        collision: clipFrame.collision ?? { x: 0, y: 0, width: 1, height: 1 },
        pivot: clipFrame.pivot,
        width: clipFrame.width,
        height: clipFrame.height,
      };
    }
  }
  const fallback = options.sprite.frames[0];
  if (!fallback) return null;
  return {
    collision: fallback.collision ?? { x: 0, y: 0, width: 1, height: 1 },
    pivot: fallback.pivot,
    width: fallback.width,
    height: fallback.height,
  };
}

function divideScale(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
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
