import type {
  ColliderDesc,
  LineTraceOptions,
  PhysicsBackend,
  PhysicsTransform,
  Vec3,
  TeleportOptions,
} from "@babylonslate/physics";
import {
  decodeTileGid,
  parseMeshCollisionLayer,
  parseMeshCollisionMask,
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
  type ColliderShape,
} from "@babylonslate/physics";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import { PreparedColliderGeometry, sameDescriptor, transformDescriptor } from "./physics-preparation";
import { componentColliderPhysicsId } from "./physics-collider-id";
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
  private readonly actorById = new Map<string, Actor>();
  private readonly bodyOwnerByActor = new Map<string, Actor>();
  private readonly preparedByActor = new Map<string, { actor: Actor; descriptor: readonly unknown[]; colliders: Map<string, ColliderDesc> }>();
  private readonly geometryByComponent = new WeakMap<ActorComponent, Map<string, PreparedColliderGeometry>>();
  private readonly ordinaryByComponent = new WeakMap<ActorComponent, { shapeSource: unknown; shape: ColliderShape }>();
  private readonly meshSources = new WeakMap<ActorComponent, { descriptor: readonly unknown[]; collisions: ReturnType<typeof resolveMeshCollisions> }>();
  private readonly rigidProperties = new WeakMap<ActorComponent, { descriptor: readonly unknown[]; value: ReturnType<typeof parseRigidBodyProperties> }>();
  private modelInstallation = 0;
  private spriteInstallation = 0;
  private tileInstallation = 0;
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
  private tilemapCollidersByActor = new Map<string, {
    component: ActorComponent;
    assetGuid: string | null;
    colliders: readonly ColliderDesc[];
  }>();
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
    this.tileInstallation++;
    this.tilemaps = ownedContentMap(options.tilemaps);
    this.tilesets = ownedContentMap(options.tilesets);
    this.tilemapCollidersByActor.clear();
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
    this.spriteInstallation++;
    this.sprites = ownedContentMap(options.sprites);
    this.spriteAnimations = ownedContentMap(options.spriteAnimations);
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
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
    this.modelInstallation++;
    this.models = ownedContentMap(options.models);
    this.complexMeshes = options.complexMeshes
      ? ownedContentMap(options.complexMeshes)
      : new Map();
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
    this.preparedByActor.clear();
    this.bodyOwnerByActor.clear();
    this.actorById.clear();
    this.tilemapCollidersByActor.clear();
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    this.actors = world.getActors();
    this.indexActors();
    this.worldTransforms = actorWorldTransforms(this.actors, this.actorById);
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
      if (this.bodyOwnerByActor.has(actor.guid) && this.bodyOwnerByActor.get(actor.guid) !== actor) this.retireActor(actor.guid);
      if (!this.bodyByActor.has(actor.guid)) {
        this.createForActor(actor);
      } else {
        const bodyId = this.bodyByActor.get(actor.guid)!;
        if (rigid) {
          const props = this.rigidProps(rigid);
          if (props.motionType === "kinematic") {
            this.backend.setBodyTargetTransform(
              bodyId,
              actorWorldPhysicsTransform(actor, this.worldTransforms),
            );
          } else if (props.motionType === "static") {
            this.backend.teleportBody(
              bodyId,
              actorWorldPhysicsTransform(actor, this.worldTransforms),
            );
          }
        } else {
          this.backend.teleportBody(
            bodyId,
            actorWorldPhysicsTransform(actor, this.worldTransforms),
          );
        }
        this.applyActorColliders(actor, bodyId);
      }
    }
    for (const actorId of this.bodyByActor.keys()) {
      if (!live.has(actorId)) this.retireActor(actorId);
    }
  }

  private indexActors(): void {
    this.actorById.clear();
    for (const actor of this.actors) this.actorById.set(actor.guid, actor);
  }

  private retireActor(actorId: string): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (bodyId) this.backend.destroyBody(bodyId);
    this.bodyByActor.delete(actorId);
    this.bodyOwnerByActor.delete(actorId);
    this.characterByActor.delete(actorId);
    this.spriteClipByActor.delete(actorId);
    this.preparedByActor.delete(actorId);
    this.tilemapCollidersByActor.delete(actorId);
  }

  step(dt: number, world: World): void {
    this.syncFromWorld(world);
    this.backend.step(dt);
    for (const [actorId, bodyId] of this.bodyByActor) {
      const actor = this.actorById.get(actorId);
      if (!actor || actor.destroyed) continue;
      const transform = this.backend.getBodyTransform(bodyId);
      if (!transform) continue;
      const local = actorLocalPhysicsTransform(transform, actor, this.worldTransforms);
      Object.assign(actor.transform.position, local.position);
      Object.assign(actor.transform.rotation, local.rotation);
    }
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions) {
    return this.backend.lineTrace(start, end, options);
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

  /** Steering updates velocity through physics without replacing its pose. */
  setActorLinearVelocity(actorId: string, velocity: Partial<Vec3>): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (bodyId) this.backend.setBodyLinearVelocity(bodyId, velocity);
  }

  /** Explicit authored pose writes are visible to the next synchronous query. */
  teleportActor(actor: Actor, world: World, options?: TeleportOptions): void {
    if (actor.destroyed || !this.actorFilter(actor)) return;
    // Scripts and inspector writes may run before the next fixed tick and can
    // also change a parent. Resolve current authored world poses at this boundary.
    this.actors = world.getActors();
    this.indexActors();
    this.worldTransforms = actorWorldTransforms(this.actors, this.actorById);
    if (this.bodyOwnerByActor.has(actor.guid) && this.bodyOwnerByActor.get(actor.guid) !== actor) this.retireActor(actor.guid);
    if (!this.bodyByActor.has(actor.guid)) this.createForActor(actor);
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return;
    this.applyActorColliders(actor, bodyId);
    this.backend.teleportBody(bodyId, actorWorldPhysicsTransform(actor, this.worldTransforms), options);
  }

  /** Apply mid-Play RigidBody / Collider inspector knobs to the live backend. */
  applyComponent(component: ActorComponent): void {
    const owner = component.owner;
    if (!owner || owner.destroyed || component.destroyed) return;
    if (!this.actorFilter(owner)) return;
    const bodyId = this.bodyByActor.get(owner.guid);
    if (!bodyId) return;
    if (component.classId === "RigidBodyComponent") {
      const props = this.rigidProps(component);
      this.backend.updateBody(bodyId, {
        motionType: props.motionType,
        mass: props.mass,
        linearDamping: props.linearDamping,
        angularDamping: props.angularDamping,
        gravityScale: props.gravityScale,
      });
      return;
    }
    if (["MeshComponent", "ColliderComponent", "SpriteComponent", "TilemapComponent", "BlockingVolumeComponent"].includes(component.classId)) {
      this.worldTransforms = actorWorldTransforms(this.actors);
      this.applyActorColliders(owner, bodyId);
    }
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
    const props = rigid ? this.rigidProps(rigid) : parseRigidBodyProperties({ motionType: "static", mass: 0, gravityScale: 0 });
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
    try {
      this.applyActorColliders(actor, bodyId);
      this.bodyByActor.set(actor.guid, bodyId);
      this.bodyOwnerByActor.set(actor.guid, actor);
    } catch (error) {
      this.backend.destroyBody(bodyId);
      this.preparedByActor.delete(actor.guid);
      this.tilemapCollidersByActor.delete(actor.guid);
      throw error;
    }
  }

  /** Prepare one complete logical collider set, then publish one native batch. */
  private applyActorColliders(actor: Actor, bodyId: string): void {
    const descriptor = this.actorCollisionDescriptor(actor);
    const prepared = this.preparedByActor.get(actor.guid);
    if (prepared?.actor === actor && sameDescriptor(prepared.descriptor, descriptor)) return;
    const colliders = new Map<string, ColliderDesc>();

    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) {
        continue;
      }
      const collider = this.ordinaryCollider(component);
      const baked = this.geometry(component, "ordinary").prepare(collider.shape, component.transform, worldScale(actor, this.worldTransforms));
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, {
        id,
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

    const blocking = actor.components.find((component) => component.classId === "BlockingVolumeComponent" && !component.destroyed);
    if (blocking) this.collectBlockingVolumeCollider(actor, bodyId, blocking, colliders);
    const tilemap = actor.components.find((component) => component.classId === "TilemapComponent" && !component.destroyed);
    if (tilemap) {
      const assetGuid = componentAssetGuid(tilemap);
      let prepared = this.tilemapCollidersByActor.get(actor.guid);
      if (prepared?.component !== tilemap || prepared.assetGuid !== assetGuid) {
        const collected = new Map<string, ColliderDesc>();
        this.collectTilemapColliders(actor, bodyId, tilemap, collected);
        prepared = { component: tilemap, assetGuid, colliders: [...collected.values()] };
        this.tilemapCollidersByActor.set(actor.guid, prepared);
      }
      for (const collider of prepared.colliders) colliders.set(collider.id, collider);
    } else {
      this.tilemapCollidersByActor.delete(actor.guid);
    }
    this.collectSpriteColliders(actor, bodyId, colliders);
    this.collectMeshColliders(actor, bodyId, colliders);

    const previous = prepared?.actor === actor ? prepared.colliders : new Map<string, ColliderDesc>();
    const upsert: ColliderDesc[] = [];
    for (const collider of colliders.values()) {
      if (!sameColliderDescriptor(previous.get(collider.id), collider)) upsert.push(collider);
    }
    const remove = [...previous.keys()].filter((id) => !colliders.has(id));
    if (upsert.length || remove.length) this.backend.applyColliderChanges(bodyId, { upsert, remove });
    this.preparedByActor.set(actor.guid, { actor, descriptor, colliders });
  }

  private rigidProps(component: ActorComponent): ReturnType<typeof parseRigidBodyProperties> {
    const names = ["motionType", "mass", "linearDamping", "angularDamping", "gravityScale"];
    const descriptor = names.map(name => component.getVariable(name));
    const old = this.rigidProperties.get(component);
    if (old && sameDescriptor(old.descriptor, descriptor)) return old.value;
    const value = parseRigidBodyProperties(Object.fromEntries(names.map((name, index) => [name, descriptor[index]])));
    this.rigidProperties.set(component, { descriptor, value });
    return value;
  }

  private ordinaryCollider(component: ActorComponent): ReturnType<typeof parseColliderProperties> {
    const shapeSource = component.getVariable("shape");
    let prepared = this.ordinaryByComponent.get(component);
    if (!prepared || prepared.shapeSource !== shapeSource) {
      prepared = { shapeSource, shape: parseColliderProperties({ shape: shapeSource }, this.backend.kind).shape };
      this.ordinaryByComponent.set(component, prepared);
    }
    const tuning = Object.fromEntries(["friction", "restitution", "isTrigger", "layer", "mask"].map(name => [name, component.getVariable(name)]));
    return { ...parseColliderProperties(tuning, this.backend.kind), shape: prepared.shape };
  }

  private geometry(component: ActorComponent, id: string): PreparedColliderGeometry {
    let geometries = this.geometryByComponent.get(component);
    if (!geometries) { geometries = new Map(); this.geometryByComponent.set(component, geometries); }
    let prepared = geometries.get(id);
    if (!prepared) { prepared = new PreparedColliderGeometry(); geometries.set(id, prepared); }
    return prepared;
  }

  private actorCollisionDescriptor(actor: Actor): readonly unknown[] {
    const scale = worldScale(actor, this.worldTransforms);
    const descriptor: unknown[] = [actor, actorParentGuid(actor), scale.x, scale.y, scale.z];
    for (const component of actor.components) {
      if (!["ColliderComponent", "MeshComponent", "SpriteComponent", "TilemapComponent", "BlockingVolumeComponent"].includes(component.classId)) continue;
      descriptor.push(component, component.destroyed, component.parentId, componentAssetGuid(component), ...transformDescriptor(component.transform));
      if (component.destroyed) continue;
      for (const name of ["shape", "friction", "restitution", "isTrigger", "layer", "mask", "collisionMode", "meshKind"]) descriptor.push(component.getVariable(name));
      if (component.classId === "MeshComponent" && componentAssetGuid(component)) descriptor.push(this.modelInstallation);
      if (component.classId === "TilemapComponent") descriptor.push(this.tileInstallation);
      if (component.classId === "SpriteComponent") {
        const playback = this.spriteClipByActor.get(actor.guid);
        const frame = resolveSpriteCollisionFrame({ sprite: this.sprites.get(componentAssetGuid(component) ?? ""), animation: playback ? this.spriteAnimations.get(playback.assetGuid) : undefined, playback });
        descriptor.push(this.spriteInstallation, this.pixelsPerUnit, frame?.collision.x, frame?.collision.y, frame?.collision.width, frame?.collision.height, frame?.pivot.x, frame?.pivot.y, frame?.width, frame?.height);
      }
    }
    return descriptor;
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

  private resolvedMeshCollisions(component: ActorComponent): ReturnType<typeof resolveMeshCollisions> {
    const assetGuid = componentAssetGuid(component);
    const descriptor = [assetGuid, component.getVariable("collisionMode"), component.getVariable("meshKind"), assetGuid ? this.modelInstallation : 0];
    const previous = this.meshSources.get(component);
    if (previous && sameDescriptor(previous.descriptor, descriptor)) return previous.collisions;
    const collisions = resolveMeshCollisions({ assetGuid, collisionMode: descriptor[1], meshKind: descriptor[2] }, {
      modelPayload: assetGuid ? this.models.get(assetGuid) : undefined,
      complexMesh: assetGuid ? this.complexMeshes.get(assetGuid) : undefined,
    });
    this.meshSources.set(component, { descriptor, collisions });
    this.geometryByComponent.delete(component);
    return collisions;
  }

  private collectMeshColliders(actor: Actor, bodyId: string, colliders: Map<string, ColliderDesc>): void {
    for (const component of this.meshPhysicsComponents(actor)) {
      const layer = parseMeshCollisionLayer(component.getVariable("layer"));
      const mask = parseMeshCollisionMask(component.getVariable("mask"));
      for (const collision of this.resolvedMeshCollisions(component)) {
        const colliderId = componentColliderPhysicsId(actor.guid, component.guid, collision.shapeId);
        const baked = this.geometry(component, collision.shapeId).prepareImported(collision.shape as ColliderShape, {
          position: { x: collision.position[0], y: collision.position[1], z: collision.position[2] },
          rotation: { x: collision.rotation[0], y: collision.rotation[1], z: collision.rotation[2], w: collision.rotation[3] },
          scale: { x: collision.scale[0], y: collision.scale[1], z: collision.scale[2] },
        }, component.transform, worldScale(actor, this.worldTransforms));
        colliders.set(colliderId, {
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
      }
    }
  }

  private collectBlockingVolumeCollider(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    colliders: Map<string, ColliderDesc>,
  ): void {
    const scale = worldScale(actor, this.worldTransforms);
    const hx = Math.max(Math.abs(scale.x) / 2, 0.05);
    const hy = Math.max(Math.abs(scale.y) / 2, 0.05);
    const hz = Math.max(Math.abs(scale.z) / 2, 0.05);
    const id = componentColliderPhysicsId(actor.guid, component.guid);
    colliders.set(id, {
      id,
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

  private collectSpriteColliders(actor: Actor, bodyId: string, colliders: Map<string, ColliderDesc>): void {
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
    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) {
        continue;
      }
      const collider = this.ordinaryCollider(component);
      if (collider.shape.kind !== "box2d") continue;
      const colliderId = componentColliderPhysicsId(actor.guid, component.guid);
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
      colliders.set(colliderId, {
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
    }
  }

  private collectTilemapColliders(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    colliders: Map<string, ColliderDesc>,
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
      return decodeTileGid(tilemap, gid, this.tilesets);
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
          const id = `tilemap:${actor.guid}:${layer.id}:${chunk.cx}:${chunk.cy}:${index}`;
          colliders.set(id, {
            id,
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

export function actorLocalPhysicsTransform(
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

function componentAssetGuid(component: ActorComponent): string | null {
  const value = component.assetGuid ?? component.getVariable("assetGuid");
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}


function sameColliderDescriptor(a: ColliderDesc | undefined, b: ColliderDesc): boolean {
  return !!a && a.shape === b.shape && a.friction === b.friction && a.restitution === b.restitution && a.isTrigger === b.isTrigger && a.layer === b.layer && a.mask === b.mask &&
    a.translation?.x === b.translation?.x && a.translation?.y === b.translation?.y && a.translation?.z === b.translation?.z &&
    a.rotation?.x === b.rotation?.x && a.rotation?.y === b.rotation?.y && a.rotation?.z === b.rotation?.z && a.rotation?.w === b.rotation?.w;
}

/** Installation owns immutable collision content; each call is a new source generation. */
function ownedContentMap<T>(value: ReadonlyMap<string, T> | Readonly<Record<string, T>>): Map<string, T> {
  return new Map([...toMap(value)].map(([guid, content]) => [guid, structuredClone(content)]));
}
