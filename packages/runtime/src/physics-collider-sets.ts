import {
  normalizeWaterBuoyancy,
  resolveCollisionFilter,
  type CollisionFilter,
  type CollisionPreset,
  type Transform,
} from "@haptic/core";
import {
  multiplyQuat,
  parseColliderProperties,
  rotateQuatVec,
  type ColliderDesc,
  type ColliderShape,
  type PhysicsBackend,
  type PhysicsTransform,
  type Vec3,
} from "@haptic/physics";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { actorParentGuid, inverseQuaternion, rotateVector } from "./actor-world-transform";
import { dynamicMeshCollisionDescriptor } from "./dynamic-mesh-collision";
import { parsedMovementProperties } from "./movement-settings";
import type { MovementDrive } from "./physics-body-classification";
import { componentColliderPhysicsId, hostedColliderPhysicsId } from "./physics-collider-id";
import { unitQuaternion, type HostedShape } from "./physics-hosting";
import { MeshColliders, type MeshCollidersHost } from "./physics-mesh-colliders";
import { DescriptorScratch, PreparedColliderGeometry, componentAssetGuid } from "./physics-preparation";
import { SpriteTileColliders, type SpriteTileCollidersHost } from "./physics-sprite-tile-colliders";

/**
 * Each body's collider set: the shapes its actor's own components supply,
 * Movement's capsule and its hosted children's solid shapes. A set is described
 * in place and published to the backend as one batch only when that descriptor
 * changed. Mesh-family and sprite or tilemap shapes come from `meshes` and
 * `tiles`, which hold the installed content they are built from.
 */
export class PhysicsColliderSets implements MeshCollidersHost, SpriteTileCollidersHost {
  readonly meshes: MeshColliders;
  readonly tiles: SpriteTileColliders;
  private readonly backend: Pick<PhysicsBackend, "kind" | "applyColliderChanges">;
  private readonly collisionPresets: readonly Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask">[] | undefined;
  private readonly preparedByActor = new Map<
    string,
    {
      actor: Actor;
      descriptor: readonly unknown[];
      colliders: Map<string, ColliderDesc>;
    }
  >();
  private readonly geometryByComponent = new WeakMap<
    ActorComponent,
    Map<string, PreparedColliderGeometry>
  >();
  private readonly ordinaryByComponent = new WeakMap<
    ActorComponent,
    { shapeSource: unknown; shape: ColliderShape }
  >();
  private readonly hostedScratch = new Map<string, ColliderDesc>();
  private readonly collisionScratch = new DescriptorScratch();

  constructor(
    backend: Pick<PhysicsBackend, "kind" | "applyColliderChanges">,
    collisionPresets?: readonly Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask">[],
  ) {
    this.backend = backend;
    this.collisionPresets = collisionPresets;
    this.meshes = new MeshColliders(backend.kind, this);
    this.tiles = new SpriteTileColliders(this);
  }

  /** A collider's layer and responses in this world: its Collision Preset's, or its own when Custom. */
  collisionFilter(own: CollisionFilter, presetRef: unknown): CollisionFilter {
    return resolveCollisionFilter(own, presetRef, this.collisionPresets);
  }

  /**
   * Prepare one complete logical collider set, then publish one native batch.
   * A kinematic Movement body is its capsule alone; a Rigid Body that Movement
   * steers keeps its own shapes and takes the capsule only when it has no solid
   * one. `hosted` are the children whose solid shapes this body takes over;
   * `triggersOnly` keeps only the triggers of a hosted actor's own body.
   */
  publish(
    actor: Actor,
    bodyId: string,
    world: Transform,
    drive: MovementDrive | null,
    hosted: readonly HostedShape[] | undefined,
    triggersOnly: boolean,
  ): void {
    const current = this.describe(actor, drive, world, triggersOnly, hosted);
    const prepared = this.preparedByActor.get(actor.guid);
    if (current.matches(prepared?.actor === actor ? prepared.descriptor : undefined))
      return;
    const descriptor = current.copy();
    const colliders = new Map<string, ColliderDesc>();
    if (drive && !drive.dynamic) this.collectMovementCapsule(actor, bodyId, drive.component, world, colliders);
    else {
      this.collectOwnColliders(actor, bodyId, { ...world.scale }, colliders);
      if (triggersOnly)
        for (const [id, collider] of colliders)
          if (!collider.isTrigger) colliders.delete(id);
      if (drive) {
        let solid = false;
        for (const collider of colliders.values()) solid ||= !collider.isTrigger;
        if (!solid) this.collectMovementCapsule(actor, bodyId, drive.component, world, colliders);
      }
    }
    if (hosted)
      for (const shape of hosted) this.collectHostedColliders(actor, bodyId, shape, colliders);

    const previous =
      prepared?.actor === actor
        ? prepared.colliders
        : new Map<string, ColliderDesc>();
    const upsert: ColliderDesc[] = [];
    for (const collider of colliders.values()) {
      if (!sameColliderDescriptor(previous.get(collider.id), collider))
        upsert.push(collider);
    }
    const remove = [...previous.keys()].filter((id) => !colliders.has(id));
    if (upsert.length || remove.length)
      this.backend.applyColliderChanges(bodyId, { upsert, remove });
    this.preparedByActor.set(actor.guid, { actor, descriptor, colliders });
  }

  /** The collider set last prepared for `actor`'s body; undefined when none was, or it was another actor's. */
  publishedColliders(actor: Actor): ReadonlyMap<string, ColliderDesc> | undefined {
    const prepared = this.preparedByActor.get(actor.guid);
    return prepared?.actor === actor ? prepared.colliders : undefined;
  }

  /** A retired body's set, and the sprite clip of the actor it belonged to. */
  forgetActor(actorId: string, owner: Actor | undefined): void {
    if (owner) this.tiles.forgetSpriteClip(owner);
    this.preparedByActor.delete(actorId);
  }

  /** A body whose creation failed: its set only, never its actor's sprite clip. */
  forgetFailedBody(actorId: string): void {
    this.preparedByActor.delete(actorId);
  }

  /** What `PhysicsWorldSync.dispose` releases. Prepared shapes stay with their components. */
  clear(): void {
    this.preparedByActor.clear();
    this.tiles.clear();
    this.meshes.clear();
  }

  ordinaryCollider(
    component: ActorComponent,
  ): ReturnType<typeof parseColliderProperties> {
    const shapeSource = component.getVariable("shape");
    let prepared = this.ordinaryByComponent.get(component);
    if (!prepared || prepared.shapeSource !== shapeSource) {
      prepared = {
        shapeSource,
        shape: parseColliderProperties(
          { shape: shapeSource },
          this.backend.kind,
        ).shape,
      };
      this.ordinaryByComponent.set(component, prepared);
    }
    const tuning = Object.fromEntries(
      ["friction", "restitution", "isTrigger", "layer", "mask", "overlapMask", "collisionPreset"].map((name) => [
        name,
        component.getVariable(name),
      ]),
    );
    return {
      ...parseColliderProperties(tuning, this.backend.kind),
      shape: prepared.shape,
    };
  }

  geometry(
    component: ActorComponent,
    id: string,
  ): PreparedColliderGeometry {
    let geometries = this.geometryByComponent.get(component);
    if (!geometries) {
      geometries = new Map();
      this.geometryByComponent.set(component, geometries);
    }
    let prepared = geometries.get(id);
    if (!prepared) {
      prepared = new PreparedColliderGeometry();
      geometries.set(id, prepared);
    }
    return prepared;
  }

  forgetGeometry(component: ActorComponent): void {
    this.geometryByComponent.delete(component);
  }

  /** Movement's upright capsule from Radius and Height, in world units whatever the actor's scale. */
  private collectMovementCapsule(
    actor: Actor,
    bodyId: string,
    movement: ActorComponent,
    world: Transform,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const props = parsedMovementProperties.get(movement);
    const id = componentColliderPhysicsId(actor.guid, movement.guid);
    colliders.set(id, {
      id, bodyId,
      shape: { kind: this.backend.kind === "3d" ? "capsule" : "capsule2d", radius: props.radius, halfHeight: props.height / 2 - props.radius },
      rotation: uprightCapsuleRotation(world.rotation), friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff,
    });
  }

  /** Every collider an actor's own components supply, sized by its world `scale`. */
  private collectOwnColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    for (const component of actor.components) {
      if (
        component.classId !== "ColliderComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        continue;
      }
      const collider = this.ordinaryCollider(component);
      const baked = this.geometry(component, "ordinary").prepare(
        collider.shape,
        component.transform,
        scale,
      );
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, {
        id,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        ...this.collisionFilter(collider, component.getVariable("collisionPreset")),
        translation: baked.translation,
        rotation: baked.rotation,
      });
    }

    const blocking = actor.components.find(
      (component) =>
        component.classId === "BlockingVolumeComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (blocking)
      this.collectBlockingVolumeCollider(actor, bodyId, blocking, scale, colliders);
    this.tiles.collectTilemap(actor, bodyId, scale, colliders);
    this.tiles.collectSpriteColliders(actor, bodyId, scale, colliders);
    this.meshes.collectMeshColliders(actor, bodyId, scale, colliders);
    this.meshes.collectLandscapeColliders(actor, bodyId, scale, colliders);
    this.meshes.collectDynamicMeshColliders(actor, bodyId, scale, colliders);
    // Adding buoyancy alone is enough for a physical float. Authored collision wins.
    const buoyancy = actor.components.find((c) => c.classId === "WaterBuoyancyComponent" && !c.destroyed && c.owner === actor);
    if (this.backend.kind === "3d" && colliders.size === 0 && buoyancy) {
      const props = normalizeWaterBuoyancy(Object.fromEntries(buoyancy.variables));
      const collider = parseColliderProperties({}, "3d");
      const transform = { ...buoyancy.transform, position: { ...buoyancy.transform.position } };
      const offset = rotateVector(transform.rotation, { x: props.offset[0] * transform.scale.x, y: props.offset[1] * transform.scale.y, z: props.offset[2] * transform.scale.z });
      transform.position.x += offset.x; transform.position.y += offset.y; transform.position.z += offset.z;
      const baked = this.geometry(buoyancy, "water").prepare({ kind: "box", halfExtents: { x: props.width / 2, y: props.height / 2, z: props.length / 2 } }, transform, scale);
      const id = componentColliderPhysicsId(actor.guid, buoyancy.guid);
      colliders.set(id, { ...collider, ...baked, id, bodyId });
    }
  }

  /** A hosted child's solid colliders, moved into the host's body frame. */
  private collectHostedColliders(
    host: Actor,
    bodyId: string,
    { actor, relative }: HostedShape,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const own = this.hostedScratch;
    own.clear();
    // Collected exactly as the child's own body would be, then re-attached.
    this.collectOwnColliders(actor, `body:${actor.guid}`, { ...relative.scale }, own);
    // Native bodies use unit rotations, as the child's own body did.
    const rotation = unitQuaternion(relative.rotation);
    for (const collider of own.values()) {
      if (collider.isTrigger) continue;
      const offset = collider.translation
        ? rotateQuatVec(rotation, collider.translation)
        : { x: 0, y: 0, z: 0 };
      const id = hostedColliderPhysicsId(collider.id, host.guid);
      colliders.set(id, {
        ...collider,
        id,
        bodyId,
        actorId: actor.guid,
        translation: {
          x: relative.position.x + offset.x,
          y: relative.position.y + offset.y,
          z: relative.position.z + offset.z,
        },
        rotation: collider.rotation ? multiplyQuat(rotation, collider.rotation) : rotation,
      });
    }
    own.clear();
  }

  /**
   * Written into reusable scratch; the caller copies it only when it changed.
   * A host also covers each hosted child: its pose in the host frame (which
   * ignores the host's world pose) and its collision components.
   */
  private describe(
    actor: Actor,
    drive: MovementDrive | null,
    world: Transform,
    triggersOnly: boolean,
    hosted: readonly HostedShape[] | undefined,
  ): DescriptorScratch {
    const descriptor = this.collisionScratch;
    descriptor.begin();
    descriptor.push(actor);
    if (drive) {
      const rotation = uprightCapsuleRotation(world.rotation);
      // Movement's capsule is a fixed world size. Visual frames, local component
      // transforms, and scale cannot change it.
      descriptor.push(drive.component);
      descriptor.push(drive.dynamic);
      descriptor.push(drive.component.getVariable("radius"));
      descriptor.push(drive.component.getVariable("height"));
      descriptor.push(rotation.x);
      descriptor.push(rotation.y);
      descriptor.push(rotation.z);
      descriptor.push(rotation.w);
    }
    if (!drive || drive.dynamic) {
      const scale = world.scale;
      descriptor.push(actorParentGuid(actor));
      descriptor.push(scale.x);
      descriptor.push(scale.y);
      descriptor.push(scale.z);
      descriptor.push(triggersOnly);
      this.pushComponentDescriptors(descriptor, actor);
    }
    if (hosted)
      for (const { actor: child, relative } of hosted) {
        descriptor.push(child);
        descriptor.pushTransform(relative);
        this.pushComponentDescriptors(descriptor, child);
      }
    return descriptor;
  }

  private pushComponentDescriptors(descriptor: DescriptorScratch, actor: Actor): void {
    for (const component of actor.components) {
      if (!COLLISION_DESCRIPTOR_CLASSES.has(component.classId)) continue;
      descriptor.push(component);
      descriptor.push(component.owner);
      descriptor.push(component.destroyed);
      descriptor.push(component.parentId);
      descriptor.push(componentAssetGuid(component));
      descriptor.pushTransform(component.transform);
      if (component.destroyed) continue;
      if (component.classId === "DynamicRuntimeMeshComponent")
        for (const value of dynamicMeshCollisionDescriptor(component))
          descriptor.push(value);
      for (const name of COLLISION_DESCRIPTOR_VARIABLES)
        descriptor.push(component.getVariable(name));
      if (component.classId === "LandscapeComponent") {
        descriptor.push(component.getVariable("collisionsEnabled"));
        descriptor.push(component.getVariable("depth"));
        descriptor.push(component.getVariable("subdivisions"));
        descriptor.push(component.getVariable("heights"));
      }
      if (component.classId === "MeshComponent")
        this.meshes.pushMeshDescriptor(descriptor, component);
      if (component.classId === "TilemapComponent")
        this.tiles.pushTilemapDescriptor(descriptor);
      if (component.classId === "SpriteComponent")
        this.tiles.pushSpriteDescriptor(descriptor, actor, component);
    }
  }

  private collectBlockingVolumeCollider(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
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
}

function sameColliderDescriptor(
  a: ColliderDesc | undefined,
  b: ColliderDesc,
): boolean {
  return (
    !!a &&
    a.shape === b.shape &&
    a.friction === b.friction &&
    a.restitution === b.restitution &&
    a.isTrigger === b.isTrigger &&
    a.layer === b.layer &&
    a.mask === b.mask &&
    (a.overlapMask ?? 0) === (b.overlapMask ?? 0) &&
    a.translation?.x === b.translation?.x &&
    a.translation?.y === b.translation?.y &&
    a.translation?.z === b.translation?.z &&
    a.rotation?.x === b.rotation?.x &&
    a.rotation?.y === b.rotation?.y &&
    a.rotation?.z === b.rotation?.z &&
    a.rotation?.w === b.rotation?.w
  );
}

/** Components whose inspector edits rebuild their owner's colliders. */
export const COLLIDER_REFRESH_CLASSES = new Set([
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "LandscapeComponent",
  "ColliderComponent",
  "SpriteComponent",
  "TilemapComponent",
  "BlockingVolumeComponent",
]);

const COLLISION_DESCRIPTOR_CLASSES = new Set([
  "ColliderComponent",
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "LandscapeComponent",
  "SpriteComponent",
  "TilemapComponent",
  "BlockingVolumeComponent",
  "WaterBuoyancyComponent",
  "MovementComponent",
]);

const COLLISION_DESCRIPTOR_VARIABLES = [
  "shape",
  "friction",
  "restitution",
  "isTrigger",
  "layer",
  "mask",
  "overlapMask",
  "collisionPreset",
  "collisionMode",
  "meshKind",
  "assetGuid",
  "width",
  "length",
  "height",
  "offset",
  "radius",
] as const;

/** An upright capsule needs an axis correction, never a twist around that axis. */
function uprightCapsuleRotation(rotation: PhysicsTransform["rotation"]): PhysicsTransform["rotation"] {
  const up = rotateVector(inverseQuaternion(rotation), { x: 0, y: 1, z: 0 });
  const length = Math.hypot(up.x, up.y, up.z);
  if (length === 0) return { x: 0, y: 0, z: 0, w: 1 };
  const x = up.z / length, z = -up.x / length, w = 1 + up.y / length;
  const norm = Math.hypot(x, z, w);
  if (norm < 1e-8) return { x: 1, y: 0, z: 0, w: 0 };
  return { x: x === 0 ? 0 : x / norm, y: 0, z: z === 0 ? 0 : z / norm, w: w / norm };
}
