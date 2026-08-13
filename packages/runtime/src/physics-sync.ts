import type { PhysicsBackend, PhysicsTransform, Vec3 } from "@babylonslate/physics";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import type { Actor, World } from "@babylonslate/object-model";

/**
 * Keeps `@babylonslate/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent.
 */
export class PhysicsWorldSync {
  private readonly backend: PhysicsBackend;
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private synced = false;

  constructor(backend: PhysicsBackend) {
    this.backend = backend;
  }

  getBackend(): PhysicsBackend {
    return this.backend;
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
      if (!rigid) continue;
      live.add(actor.guid);
      if (!this.bodyByActor.has(actor.guid)) {
        this.createForActor(actor);
      } else {
        // Keep kinematic/static transforms authored by scripts.
        const bodyId = this.bodyByActor.get(actor.guid)!;
        const props = parseRigidBodyProperties(
          mapToRecord(rigid.variables),
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
    if (!rigid) return;
    const bodyId = `body:${actor.guid}`;
    const props = parseRigidBodyProperties(mapToRecord(rigid.variables));
    this.backend.createBody({
      id: bodyId,
      actorId: actor.guid,
      motionType: props.motionType,
      mass: props.mass,
      linearDamping: props.linearDamping,
      angularDamping: props.angularDamping,
      gravityScale: props.gravityScale,
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
