import { parseRigidBodyProperties, type PhysicsWorldKind } from "@haptic/physics";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { dynamicRuntimeGeometry } from "./dynamic-runtime-mesh";
import type { MeshColliders } from "./physics-mesh-colliders";
import { sameDescriptor } from "./physics-preparation";

/**
 * How Movement moves an actor. `dynamic`: it steers the velocity of the actor's
 * dynamic Rigid Body. Otherwise a kinematic capsule is moved by a character
 * controller, and `mass` scales impulses into velocity.
 */
export type MovementDrive = { component: ActorComponent; dynamic: boolean; mass: number };

/**
 * Which component makes an actor a body, and how that body moves. The per-tick
 * scan (`classify`), its call-time mirrors (`movementDrive`, `rigidComponent`)
 * and hosting's checks (`isStaticSource`, `hasSolidCollision`) differ on
 * purpose, such as when disabled Dynamic Runtime Mesh collision is released, so
 * they live together without sharing one scan.
 */
export class PhysicsBodyClassifier {
  private readonly kind: PhysicsWorldKind;
  private readonly meshes: Pick<MeshColliders, "resolvedMeshCollisions" | "dynamicMeshPhysicsComponents">;
  private readonly rigidProperties = new WeakMap<
    ActorComponent,
    {
      descriptor: readonly unknown[];
      value: ReturnType<typeof parseRigidBodyProperties>;
    }
  >();
  private readonly rigidScratch: unknown[] = [];

  constructor(
    kind: PhysicsWorldKind,
    meshes: Pick<MeshColliders, "resolvedMeshCollisions" | "dynamicMeshPhysicsComponents">,
  ) {
    this.kind = kind;
    this.meshes = meshes;
  }

  /**
   * One membership scan per actor and tick. Returns false for an actor without
   * a body source, otherwise its Movement component (as `movementDrive`
   * resolves it, whatever the motion of a Rigid Body beside it), its rigid
   * component (RigidBody, or buoyancy in 3D), or null for an implicit static
   * body. Mesh collision sources still resolve for every live MeshComponent,
   * and disabled dynamic meshes are released only when no earlier source
   * supplies a body, as before.
   */
  classify(actor: Actor): ActorComponent | null | false {
    const is3d = this.kind === "3d";
    let rigidBody: ActorComponent | undefined;
    let buoyancy: ActorComponent | undefined;
    let movement: ActorComponent | undefined;
    let movementExcluded = false;
    let implicit = false;
    let dynamicMesh = false;
    for (const component of actor.components) {
      if (component.classId === "DynamicRuntimeMeshComponent") {
        dynamicMesh = true;
        continue;
      }
      if (component.destroyed || component.owner !== actor) continue;
      switch (component.classId) {
        case "RigidBodyComponent":
          rigidBody ??= component;
          break;
        case "WaterBuoyancyComponent":
          buoyancy ??= component;
          movementExcluded = true;
          break;
        case "NavAgentComponent":
        case "RagdollComponent":
          movementExcluded = true;
          break;
        case "MovementComponent":
          // A second Movement component disables both.
          if (movement) movementExcluded = true;
          movement = component;
          break;
        case "TilemapComponent":
        case "BlockingVolumeComponent":
          implicit = true;
          break;
        case "MeshComponent":
          if (is3d && this.meshes.resolvedMeshCollisions(component).length > 0)
            implicit = true;
          break;
        case "LandscapeComponent":
          if (is3d && component.getVariable("collisionsEnabled") === true)
            implicit = true;
          break;
      }
    }
    // A static Rigid Body cannot move, so it keeps the actor and Movement is a conflict.
    if (movement && !movementExcluded && (!rigidBody || this.rigidProps(rigidBody).motionType !== "static"))
      return movement;
    const rigid = rigidBody ?? (is3d ? buoyancy : undefined);
    if (rigid) return rigid;
    if (implicit) return null;
    return dynamicMesh && this.meshes.dynamicMeshPhysicsComponents(actor).length > 0
      ? null
      : false;
  }

  isStaticSource(source: ActorComponent | null): boolean {
    return source === null ||
      (source.classId !== "MovementComponent" && this.rigidProps(source).motionType === "static");
  }

  /** Whether the actor supplies a non-trigger collider, the shapes a host takes over. */
  hasSolidCollision(actor: Actor): boolean {
    const is3d = this.kind === "3d";
    for (const component of actor.components) {
      if (component.destroyed || component.owner !== actor) continue;
      switch (component.classId) {
        case "ColliderComponent":
          if (component.getVariable("isTrigger") !== true) return true;
          break;
        case "TilemapComponent":
        case "BlockingVolumeComponent":
          return true;
        case "MeshComponent":
          if (is3d && this.meshes.resolvedMeshCollisions(component).length > 0) return true;
          break;
        case "LandscapeComponent":
          if (is3d && component.getVariable("collisionsEnabled") === true) return true;
          break;
        case "DynamicRuntimeMeshComponent":
          if (is3d && component.getVariable("enableCollision") === true &&
            dynamicRuntimeGeometry(component)?.indices.length) return true;
          break;
      }
    }
    return false;
  }

  /**
   * How Movement moves the actor, as `classify` resolves it; undefined when
   * there is no Movement or another motion owner (Nav Agent, Ragdoll, Water
   * Buoyancy, a second Movement or a static Rigid Body) stops it.
   */
  movementDrive(actor: Actor): MovementDrive | undefined {
    let movement: ActorComponent | undefined;
    let rigid: ActorComponent | undefined;
    for (const component of actor.components) {
      if (component.destroyed || component.owner !== actor) continue;
      switch (component.classId) {
        case "RigidBodyComponent":
          rigid ??= component;
          break;
        case "WaterBuoyancyComponent":
        case "NavAgentComponent":
        case "RagdollComponent":
          return undefined;
        case "MovementComponent":
          if (movement) return undefined;
          movement = component;
          break;
      }
    }
    if (!movement) return undefined;
    if (!rigid) return { component: movement, dynamic: false, mass: 1 };
    const props = this.rigidProps(rigid);
    return props.motionType === "static" ? undefined
      : { component: movement, dynamic: props.motionType === "dynamic", mass: Math.max(props.mass, MIN_MOVEMENT_MASS) };
  }

  rigidComponent(actor: Actor): ActorComponent | undefined {
    const live = (c: ActorComponent) => !c.destroyed && c.owner === actor;
    return actor.components.find((c) => c.classId === "RigidBodyComponent" && live(c))
      ?? (this.kind === "3d" ? actor.components.find((c) => c.classId === "WaterBuoyancyComponent" && live(c)) : undefined);
  }

  rigidProps(
    component: ActorComponent,
  ): ReturnType<typeof parseRigidBodyProperties> {
    const current = this.rigidScratch;
    for (let index = 0; index < RIGID_BODY_VARIABLES.length; index++)
      current[index] = component.getVariable(RIGID_BODY_VARIABLES[index]);
    const old = this.rigidProperties.get(component);
    if (old && sameDescriptor(old.descriptor, current)) return old.value;
    const descriptor = current.slice();
    const value = parseRigidBodyProperties(
      Object.fromEntries(
        RIGID_BODY_VARIABLES.map((name, index) => [name, descriptor[index]]),
      ),
    );
    this.rigidProperties.set(component, { descriptor, value });
    return value;
  }
}

/** Matches `parseColliderProperties`, which accepts only `true`. */
export function hasTriggerCollider(actor: Actor): boolean {
  for (const component of actor.components)
    if (component.classId === "ColliderComponent" && !component.destroyed &&
      component.owner === actor && component.getVariable("isTrigger") === true) return true;
  return false;
}

const RIGID_BODY_VARIABLES = [
  "motionType",
  "mass",
  "linearDamping",
  "angularDamping",
  "gravityScale",
] as const;

export const STATIC_BODY_PROPERTIES = parseRigidBodyProperties({
  motionType: "static",
  mass: 0,
  gravityScale: 0,
});

/** An impulse's velocity change is impulse / mass; mass stays positive. */
const MIN_MOVEMENT_MASS = 1e-3;

export const MOVEMENT_BODY_PROPERTIES = parseRigidBodyProperties({
  motionType: "kinematic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0,
});
