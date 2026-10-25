import {
  parseMeshCollisionLayer,
  parseMeshCollisionMask,
  parseMeshCollisionMode,
  resolveMeshCollisions,
  type ModelPayload,
} from "@haptic/assets";
import {
  landscapeCollisionMesh,
  sameCollisionTriangleMesh,
  type CollisionFilter,
  type CollisionTriangleMesh,
} from "@haptic/core";
import type { ColliderDesc, ColliderShape, PhysicsWorldKind, Vec3 } from "@haptic/physics";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { DynamicMeshCollisionCache } from "./dynamic-mesh-collision";
import { dynamicRuntimeGeometry } from "./dynamic-runtime-mesh";
import { componentColliderPhysicsId } from "./physics-collider-id";
import {
  sameDescriptor,
  toMap,
  type DescriptorScratch,
  type PreparedColliderGeometry,
} from "./physics-preparation";

/** What `MeshColliders` uses of the collider sets that own it. */
export interface MeshCollidersHost {
  geometry(component: ActorComponent, id: string): PreparedColliderGeometry;
  /** Drops a component's prepared shapes once its resolved mesh collisions change. */
  forgetGeometry(component: ActorComponent): void;
  collisionFilter(own: CollisionFilter, presetRef: unknown): CollisionFilter;
}

/** The installed Models and cooked complex meshes (`PhysicsWorldSync.setModelContent`). */
export type ModelContent = {
  models:
    | ReadonlyMap<string, ModelPayload>
    | Readonly<Record<string, ModelPayload>>;
  complexMeshes?:
    | ReadonlyMap<string, CollisionTriangleMesh>
    | Readonly<Record<string, CollisionTriangleMesh>>;
};

/**
 * Installed Models and complex meshes, and the 3D-only colliders of Mesh,
 * Landscape and Dynamic Runtime Mesh components.
 */
export class MeshColliders {
  private readonly kind: PhysicsWorldKind;
  private readonly host: MeshCollidersHost;
  private readonly dynamicMeshCollisions = new DynamicMeshCollisionCache();
  private readonly meshSources = new WeakMap<
    ActorComponent,
    {
      descriptor: readonly unknown[];
      collisions: ReturnType<typeof resolveMeshCollisions>;
    }
  >();
  private readonly landscapeSources = new WeakMap<ActorComponent, {
    descriptor: readonly unknown[];
    shape: ReturnType<typeof landscapeCollisionMesh>;
  }>();
  private readonly modelContentIdentities = new Map<string, string>();
  private readonly meshScratch: unknown[] = [];
  private models = new Map<string, ModelPayload>();
  private complexMeshes = new Map<string, CollisionTriangleMesh>();
  private onMissingComplexMesh: ((assetGuid: string) => void) | null = null;

  constructor(kind: PhysicsWorldKind, host: MeshCollidersHost) {
    this.kind = kind;
    this.host = host;
  }

  setModelContent(options: ModelContent): void {
    const models = toMap(options.models);
    const meshes = options.complexMeshes
      ? toMap(options.complexMeshes)
      : new Map<string, CollisionTriangleMesh>();
    const nextModels = new Map<string, ModelPayload>();
    const nextMeshes = new Map<string, CollisionTriangleMesh>();
    const identities = new Map<string, string>();
    // These full-content comparisons belong to installation, never a tick.
    // Exact collision content gives each retained immutable source its identity;
    // unrelated material metadata cannot invalidate prepared physics geometry.
    for (const [guid, model] of models) {
      const identity = JSON.stringify([model.simpleColliders, model.importScale]);
      nextModels.set(
        guid,
        this.modelContentIdentities.get(guid) === identity && this.models.has(guid)
          ? this.models.get(guid)!
          : structuredClone(model),
      );
      identities.set(guid, identity);
    }
    for (const [guid, mesh] of meshes) {
      const installed = this.complexMeshes.get(guid);
      nextMeshes.set(
        guid,
        installed && sameCollisionTriangleMesh(installed, mesh)
          ? installed
          : { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
      );
    }
    this.modelContentIdentities.clear();
    for (const [guid, identity] of identities)
      this.modelContentIdentities.set(guid, identity);
    this.models = nextModels;
    this.complexMeshes = nextMeshes;
  }

  /** The host's on-demand cooking (`PhysicsWorldSync.setMissingComplexMeshHandler`). */
  setMissingComplexMeshHandler(handler: ((assetGuid: string) => void) | null): void {
    this.onMissingComplexMesh = handler;
  }

  /** What `PhysicsWorldSync.dispose` releases: the installed content and its identities. */
  clear(): void {
    this.modelContentIdentities.clear();
    this.models.clear();
    this.complexMeshes.clear();
  }

  landscapePhysicsComponents(actor: Actor): Actor["components"] {
    if (this.kind !== "3d") return [];
    return actor.components.filter((component) => component.classId === "LandscapeComponent" &&
      !component.destroyed && component.owner === actor && component.getVariable("collisionsEnabled") === true);
  }

  dynamicMeshPhysicsComponents(actor: Actor): ActorComponent[] {
    if (this.kind !== "3d") return [];
    const enabled: ActorComponent[] = [];
    for (const component of actor.components) {
      if (component.classId !== "DynamicRuntimeMeshComponent") continue;
      if (!component.destroyed && component.owner === actor && component.getVariable("enableCollision") === true &&
        dynamicRuntimeGeometry(component)?.indices.length) enabled.push(component);
      else this.dynamicMeshCollisions.remove(component);
    }
    return enabled;
  }

  collectLandscapeColliders(actor: Actor, bodyId: string, scale: Vec3, colliders: Map<string, ColliderDesc>): void {
    for (const component of this.landscapePhysicsComponents(actor)) {
      const names = ["width", "depth", "subdivisions", "heights", "collisionsEnabled"];
      const descriptor = names.map((name) => component.getVariable(name));
      let source = this.landscapeSources.get(component);
      if (!source || !sameDescriptor(source.descriptor, descriptor)) {
        source = { descriptor, shape: landscapeCollisionMesh(Object.fromEntries(names.map((name, index) => [name, descriptor[index]]))) };
        this.landscapeSources.set(component, source);
      }
      if (!source.shape) continue;
      const baked = this.host.geometry(component, "landscape").prepare(source.shape, component.transform, scale);
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, { id, bodyId, ...baked, friction: 0.5, restitution: 0, isTrigger: false, ...this.meshCollisionFilter(component) });
    }
  }

  meshPhysicsComponents(actor: Actor): Actor["components"] {
    if (this.kind !== "3d") return [];
    return actor.components.filter((component) => {
      if (
        component.classId !== "MeshComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        return false;
      }
      return this.resolvedMeshCollisions(component).length > 0;
    });
  }

  resolvedMeshCollisions(
    component: ActorComponent,
  ): ReturnType<typeof resolveMeshCollisions> {
    const assetGuid = meshAssetGuid(component);
    const current = this.meshScratch;
    current[0] = assetGuid;
    current[1] = component.getVariable("collisionMode");
    current[2] = component.getVariable("meshKind");
    current[3] = assetGuid ? this.models.get(assetGuid) : null;
    current[4] = assetGuid ? this.complexMeshes.get(assetGuid) : null;
    const previous = this.meshSources.get(component);
    if (previous && sameDescriptor(previous.descriptor, current))
      return previous.collisions;
    const descriptor = current.slice();
    const collisions = resolveMeshCollisions(
      { assetGuid, collisionMode: descriptor[1], meshKind: descriptor[2] },
      {
        modelPayload: assetGuid ? this.models.get(assetGuid) : undefined,
        complexMesh: assetGuid ? this.complexMeshes.get(assetGuid) : undefined,
      },
    );
    this.meshSources.set(component, { descriptor, collisions });
    this.host.forgetGeometry(component);
    if (assetGuid && descriptor[4] == null && parseMeshCollisionMode(descriptor[1]) === "complex")
      this.onMissingComplexMesh?.(assetGuid);
    return collisions;
  }

  collectMeshColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    for (const component of this.meshPhysicsComponents(actor)) {
      const { layer, mask, overlapMask } = this.meshCollisionFilter(component);
      for (const collision of this.resolvedMeshCollisions(component)) {
        const colliderId = componentColliderPhysicsId(
          actor.guid,
          component.guid,
          collision.shapeId,
        );
        const baked = this.host.geometry(
          component,
          collision.shapeId,
        ).prepareImported(
          collision.shape as ColliderShape,
          {
            position: {
              x: collision.position[0],
              y: collision.position[1],
              z: collision.position[2],
            },
            rotation: {
              x: collision.rotation[0],
              y: collision.rotation[1],
              z: collision.rotation[2],
              w: collision.rotation[3],
            },
            scale: {
              x: collision.scale[0],
              y: collision.scale[1],
              z: collision.scale[2],
            },
          },
          component.transform,
          scale,
        );
        colliders.set(colliderId, {
          id: colliderId,
          bodyId,
          shape: baked.shape,
          friction: 0.5,
          restitution: 0,
          isTrigger: false,
          layer,
          mask,
          overlapMask,
          translation: baked.translation,
          rotation: baked.rotation,
        });
      }
    }
  }

  /** Enabled Dynamic Runtime Mesh collision, from each component's current geometry. */
  collectDynamicMeshColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    for (const component of this.dynamicMeshPhysicsComponents(actor)) {
      const shape = this.dynamicMeshCollisions.prepare(component, scale);
      if (!shape) continue;
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, { id, bodyId, shape, friction: 0.5, restitution: 0, isTrigger: false, ...this.meshCollisionFilter(component) });
    }
  }

  /** The installed content a MeshComponent's collision descriptor covers. */
  pushMeshDescriptor(descriptor: DescriptorScratch, component: ActorComponent): void {
    const guid = meshAssetGuid(component);
    descriptor.push(guid ? this.models.get(guid) : null);
    descriptor.push(guid ? this.complexMeshes.get(guid) : null);
  }

  /** Mesh, Dynamic Runtime Mesh and Landscape collision. */
  private meshCollisionFilter(component: ActorComponent): CollisionFilter {
    return this.host.collisionFilter(
      {
        layer: parseMeshCollisionLayer(component.getVariable("layer")),
        mask: parseMeshCollisionMask(component.getVariable("mask")),
        overlapMask: overlapMaskOf(component.getVariable("overlapMask")),
      },
      component.getVariable("collisionPreset"),
    );
  }
}

function meshAssetGuid(component: ActorComponent): string | null {
  const variable = component.getVariable("assetGuid");
  if (typeof variable === "string") return variable.trim() || null;
  return component.assetGuid;
}

/** A component's `overlapMask`: layers it overlaps without blocking; none when unset. */
function overlapMaskOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value >>> 0 : 0;
}
