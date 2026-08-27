import type { PhysicsBackend, PhysicsTransform, Vec3 } from "@babylonslate/physics";
import {
  decodeTileGid,
  meshColliderId,
  parseMeshCollisionLayer,
  parseMeshCollisionMask,
  parseMeshCollisionMode,
  resolveMeshCollisions,
  spriteAnimationFrameAt,
  spriteClipFrameAt,
  spriteCollisionToBox2d,
  tilemapChunkChains,
  tilemapTilesetGuids,
  type ModelPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
  bakeColliderLocal,
  multiplyQuat,
  rotateQuatVec,
  type ColliderShape,
} from "@babylonslate/physics";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
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
 * RigidBodyComponent / ColliderComponent, MeshComponent collision, tilemap
 * collision, or a Blocking Volume.
 */
export class PhysicsWorldSync {
  private readonly backend: PhysicsBackend;
  private readonly actorFilter: (actor: Actor) => boolean;
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
  private meshColliderKeyByActor = new Map<string, Map<string, string>>();
  private models = new Map<string, ModelPayload>();
  private complexMeshes = new Map<
    string,
    { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
  >();
  private pixelsPerUnit = 100;

  constructor(
    backend: PhysicsBackend,
    options?: { actorFilter?: (actor: Actor) => boolean },
  ) {
    this.backend = backend;
    this.actorFilter = options?.actorFilter ?? (() => true);
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

  setModelContent(options: {
    models:
      | ReadonlyMap<string, ModelPayload>
      | Readonly<Record<string, ModelPayload>>;
    complexMeshes?:
      | ReadonlyMap<
          string,
          { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
        >
      | Readonly<
          Record<
            string,
            { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
          >
        >;
  }): void {
    this.models = toMap(options.models);
    this.complexMeshes = options.complexMeshes
      ? toMap(options.complexMeshes)
      : new Map();
    this.meshColliderKeyByActor.clear();
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
      if (!this.actorFilter(actor)) continue;
      const rigid = actor.components.find(
        (c) => c.classId === "RigidBodyComponent" && !c.destroyed,
      );
      const tilemap = actor.components.find(
        (c) => c.classId === "TilemapComponent" && !c.destroyed,
      );
      const blocking = actor.components.find(
        (c) => c.classId === "BlockingVolumeComponent" && !c.destroyed,
      );
      const meshPhysics = this.meshPhysicsComponents(actor).length > 0;
      if (!rigid && !tilemap && !blocking && !meshPhysics) continue;
      live.add(actor.guid);
      if (!this.bodyByActor.has(actor.guid)) {
        this.createForActor(actor);
      } else {
        const bodyId = this.bodyByActor.get(actor.guid)!;
        if (rigid) {
          const props = parseRigidBodyProperties(mapToRecord(rigid.variables));
          if (props.motionType !== "dynamic") {
            this.backend.setBodyTransform(
              bodyId,
              actorWorldPhysicsTransform(actor, this.worldTransforms),
            );
          }
        } else {
          this.backend.setBodyTransform(
            bodyId,
            actorWorldPhysicsTransform(actor, this.worldTransforms),
          );
        }
        this.applySpriteColliders(actor, bodyId);
        this.applyMeshColliders(actor, bodyId);
      }
    }
    for (const [actorId, bodyId] of [...this.bodyByActor]) {
      if (live.has(actorId)) continue;
      this.backend.destroyBody(bodyId);
      this.bodyByActor.delete(actorId);
      this.characterByActor.delete(actorId);
      this.spriteClipByActor.delete(actorId);
      this.spriteColliderKeyByActor.delete(actorId);
      this.meshColliderKeyByActor.delete(actorId);
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

  /** Apply mid-Play RigidBody / Collider inspector knobs to the live backend. */
  applyComponent(component: ActorComponent): void {
    const owner = component.owner;
    if (!owner || owner.destroyed || component.destroyed) return;
    if (!this.actorFilter(owner)) return;
    const bodyId = this.bodyByActor.get(owner.guid);
    if (!bodyId) return;
    if (component.classId === "RigidBodyComponent") {
      const props = parseRigidBodyProperties(mapToRecord(component.variables));
      this.backend.updateBody(bodyId, {
        motionType: props.motionType,
        mass: props.mass,
        linearDamping: props.linearDamping,
        angularDamping: props.angularDamping,
        gravityScale: props.gravityScale,
      });
      return;
    }
    if (component.classId === "MeshComponent") {
      this.applyMeshColliders(owner, bodyId);
      return;
    }
    if (component.classId !== "ColliderComponent") return;
    const collider = parseColliderProperties(
      mapToRecord(component.variables),
      this.backend.kind,
    );
    this.backend.updateCollider(`collider:${component.guid}`, {
      isTrigger: collider.isTrigger,
      friction: collider.friction,
      restitution: collider.restitution,
      layer: collider.layer,
      mask: collider.mask,
    });
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
    const blocking = actor.components.find(
      (c) => c.classId === "BlockingVolumeComponent" && !c.destroyed,
    );
    if (!rigid && !tilemap && !blocking && this.meshPhysicsComponents(actor).length === 0) return;
    const bodyId = `body:${actor.guid}`;
    const props = parseRigidBodyProperties(
      rigid
        ? mapToRecord(rigid.variables)
        : { motionType: "static", mass: 0, gravityScale: 0 },
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
      const baked = bakeColliderLocal(
        collider.shape,
        {
          position: component.transform.position,
          rotation: component.transform.rotation,
          scale: component.transform.scale,
        },
        worldScale(actor, this.worldTransforms),
      );
      this.backend.createCollider({
        id: `collider:${component.guid}`,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation: baked.translation,
        rotation: baked.rotation,
      });
    }

    if (blocking) this.createBlockingVolumeCollider(actor, bodyId, blocking);
    if (tilemap) this.createTilemapColliders(actor, bodyId, tilemap);
    this.applySpriteColliders(actor, bodyId);
    this.applyMeshColliders(actor, bodyId);
  }

  private meshPhysicsComponents(actor: Actor): Actor["components"] {
    if (this.backend.kind !== "3d") return [];
    return actor.components.filter((component) => {
      if (component.classId !== "MeshComponent" || component.destroyed) {
        return false;
      }
      return this.resolvedMeshCollisions(component).length > 0;
    });
  }

  private resolvedMeshCollisions(component: Actor["components"][number]) {
    const properties = mapToRecord(component.variables);
    if (parseMeshCollisionMode(properties.collisionMode) === "none") return [];
    const assetGuid =
      typeof properties.assetGuid === "string" ? properties.assetGuid.trim() : "";
    return resolveMeshCollisions(properties, {
      modelPayload: assetGuid ? this.models.get(assetGuid) : undefined,
      complexMesh: assetGuid ? this.complexMeshes.get(assetGuid) : undefined,
    });
  }

  private applyMeshColliders(actor: Actor, bodyId: string): void {
    const keys = this.meshColliderKeyByActor.get(actor.guid) ?? new Map();
    this.meshColliderKeyByActor.set(actor.guid, keys);
    const live = new Set<string>();
    for (const component of this.meshPhysicsComponents(actor)) {
      const properties = mapToRecord(component.variables);
      const layer = parseMeshCollisionLayer(properties.layer);
      const mask = parseMeshCollisionMask(properties.mask);
      for (const collision of this.resolvedMeshCollisions(component)) {
        const colliderId = meshColliderId(component.guid, collision.shapeId);
        live.add(colliderId);
        const composed = composeMeshColliderLocal(
          component.transform,
          collision,
        );
        const baked = bakeColliderLocal(
          collision.shape as ColliderShape,
          composed,
          worldScale(actor, this.worldTransforms),
        );
        const fingerprint = [
          collision.shape.kind,
          baked.translation.x,
          baked.translation.y,
          baked.translation.z,
          baked.rotation.x,
          baked.rotation.y,
          baked.rotation.z,
          baked.rotation.w,
          layer,
          mask,
        ].join(",");
        if (keys.get(colliderId) === fingerprint) continue;
        this.backend.destroyCollider(colliderId);
        this.backend.createCollider({
          id: colliderId,
          bodyId,
          shape: baked.shape,
          friction: 0.5,
          restitution: 0,
          isTrigger: false,
          layer,
          mask,
          translation: baked.translation,
          rotation: baked.rotation,
        });
        keys.set(colliderId, fingerprint);
      }
    }
    for (const colliderId of [...keys.keys()]) {
      if (live.has(colliderId)) continue;
      this.backend.destroyCollider(colliderId);
      keys.delete(colliderId);
    }
  }

  private createBlockingVolumeCollider(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
  ): void {
    const scale = worldScale(actor, this.worldTransforms);
    const hx = Math.max(Math.abs(scale.x) / 2, 0.05);
    const hy = Math.max(Math.abs(scale.y) / 2, 0.05);
    const hz = Math.max(Math.abs(scale.z) / 2, 0.05);
    this.backend.createCollider({
      id: `collider:${component.guid}`,
      bodyId,
      shape:
        this.backend.kind === "2d"
          ? { kind: "box2d", halfExtents: { x: hx, y: hy } }
          : { kind: "box", halfExtents: { x: hx, y: hy, z: hz } },
      friction: 0.5,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
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
      const baked = bakeColliderLocal(
        { kind: "box2d", halfExtents: mapped.halfExtents },
        {
          position: {
            x: component.transform.position.x + mapped.translation.x,
            y: component.transform.position.y + mapped.translation.y,
            z: component.transform.position.z,
          },
          rotation: component.transform.rotation,
          scale: component.transform.scale,
        },
        worldScale(actor, this.worldTransforms),
      );
      const fingerprint = [
        baked.shape.kind === "box2d" ? baked.shape.halfExtents.x : 0,
        baked.shape.kind === "box2d" ? baked.shape.halfExtents.y : 0,
        baked.translation.x,
        baked.translation.y,
        baked.translation.z,
        baked.rotation.x,
        baked.rotation.y,
        baked.rotation.z,
        baked.rotation.w,
      ].join(",");
      if (keys.get(colliderId) === fingerprint) continue;
      this.backend.destroyCollider(colliderId);
      this.backend.createCollider({
        id: colliderId,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation: baked.translation,
        rotation: baked.rotation,
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
    if (!tilemap || tilemapTilesetGuids(tilemap).length === 0) return;
    const ppu = this.pixelsPerUnit > 0 ? this.pixelsPerUnit : 100;
    const worldTileWidth = tilemap.tileWidth / ppu;
    const worldTileHeight = tilemap.tileHeight / ppu;
    const resolveGid = (gid: number) => {
      const hit = decodeTileGid(tilemap, gid, this.tilesets);
      if (hit) return hit;
      if (this.tilesets.size === 1) {
        const [atlasGuid, tileset] = [...this.tilesets.entries()][0]!;
        return { guid: atlasGuid, localId: gid, tileset };
      }
      return null;
    };
    const fallback = this.tilesets.get(tilemapTilesetGuids(tilemap)[0] ?? "")
      ?? this.tilesets.values().next().value;
    if (!fallback) return;
    let index = 0;
    for (const layer of tilemap.layers) {
      if (!layer.collision) continue;
      for (const chunk of layer.chunks) {
        const chains = tilemapChunkChains({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset: fallback,
          worldTileWidth,
          worldTileHeight,
          resolveGid,
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

function worldScale(
  actor: Actor,
  transforms: ActorTransformMap,
): { x: number; y: number; z: number } {
  const world = transforms.get(actor.guid) ?? actor.transform;
  return { ...world.scale };
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

function composeMeshColliderLocal(
  meshTransform: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    scale: { x: number; y: number; z: number };
  },
  collision: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  },
): {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
} {
  const childPosition = {
    x: collision.position[0] * meshTransform.scale.x,
    y: collision.position[1] * meshTransform.scale.y,
    z: collision.position[2] * meshTransform.scale.z,
  };
  const rotated = rotateQuatVec(meshTransform.rotation, childPosition);
  return {
    position: {
      x: meshTransform.position.x + rotated.x,
      y: meshTransform.position.y + rotated.y,
      z: meshTransform.position.z + rotated.z,
    },
    rotation: multiplyQuat(meshTransform.rotation, {
      x: collision.rotation[0],
      y: collision.rotation[1],
      z: collision.rotation[2],
      w: collision.rotation[3],
    }),
    scale: {
      x: meshTransform.scale.x * collision.scale[0],
      y: meshTransform.scale.y * collision.scale[1],
      z: meshTransform.scale.z * collision.scale[2],
    },
  };
}

