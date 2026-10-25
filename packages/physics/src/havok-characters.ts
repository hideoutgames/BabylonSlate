import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { CharacterSupportedState, PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import { PhysicsShapeCapsule, type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import type { CharacterControllerDesc, CharacterMovementResult, PhysicsTransform, Vec3 } from "./types";
import { normalizedPhysicsPose } from "./collider-validation";
import { detachHavokCharacterBodyShape, setHavokBodyPoseBeforeStep } from "./havok-native-adapter";
import { toVector3, type BodyRecord } from "./havok-records";

type CharacterRecord = {
  desc: CharacterControllerDesc;
  controller: PhysicsCharacterController;
  shape: PhysicsShape;
  grounded: boolean;
};

/** Character solves shorter than this integrate their displacement over the nominal step. */
const MIN_CHARACTER_SOLVE_DT = 1e-3;
const NOMINAL_CHARACTER_SOLVE_DT = 1 / 60;

/** What character movement reads from and calls on the backend that owns the world. */
export interface HavokCharacterHost {
  readonly scene: Scene;
  readonly plugin: HavokPlugin;
  readonly bodies: ReadonlyMap<string, BodyRecord>;
  flushMutations(): void;
  failMutation(record: BodyRecord, failure: Error): Error;
  getBodyTransform(bodyId: string): PhysicsTransform | null;
  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void;
  teleportBody(bodyId: string, transform: PhysicsTransform): void;
}

/** The Havok backend's character controllers: a Babylon `PhysicsCharacterController` per controller, solved on demand. */
export class HavokCharacters {
  private readonly host: HavokCharacterHost;
  private readonly characters = new Map<string, CharacterRecord>();
  /** Result holders for the ground snap cast; the plugin resets them at the start of every query. */
  private readonly castInput = new ShapeCastResult();
  private readonly castHit = new ShapeCastResult();
  private readonly zeroGravity = Vector3.Zero();
  private readonly down = new Vector3(0, -1, 0);

  constructor(host: HavokCharacterHost) {
    this.host = host;
  }

  /** Disposes the controllers driving a body that is being destroyed. */
  destroyForBody(bodyId: string): void {
    for (const [id, character] of this.characters) {
      if (character.desc.bodyId === bodyId) {
        character.controller.dispose();
        character.shape.dispose();
        this.characters.delete(id);
      }
    }
  }

  /** Moves the controllers driving a teleported body to its new position; the teleport resets their support state. */
  bodyTeleported(bodyId: string, position: Vec3): void {
    for (const character of this.characters.values()) {
      if (character.desc.bodyId === bodyId) {
        character.controller.setPosition(toVector3(position));
        character.grounded = false;
      }
    }
  }

  /** Disposes every controller and its capsule. */
  dispose(): void {
    for (const character of this.characters.values()) {
      character.controller.dispose();
      character.shape.dispose();
    }
    this.characters.clear();
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const record = this.host.bodies.get(desc.bodyId);
    if (!record) return;
    if (this.characters.has(desc.id)) this.destroyCharacterController(desc.id);
    const radius = desc.radius ?? 0.4;
    const height = Math.max(desc.height ?? 1.8, radius * 2);
    const halfSegment = height / 2 - radius;
    const shape = new PhysicsShapeCapsule(
      new Vector3(0, halfSegment, 0),
      new Vector3(0, -halfSegment, 0),
      radius,
      this.host.scene,
    );
    let controller: PhysicsCharacterController | undefined;
    try {
      controller = new PhysicsCharacterController(
        record.node.position.clone(),
        { shape, capsuleHeight: height, capsuleRadius: radius },
        this.host.scene,
      );
      controller.keepDistance = desc.offset;
      // A broad proximity tolerance makes checkSupport project gravity away
      // before the capsule reaches the floor. Ground snapping is a separate cast.
      controller.keepContactTolerance = Math.min(desc.offset, 0.001);
      controller.maxSlopeCosine = Math.cos((desc.maxSlopeAngle ?? 50) * Math.PI / 180);
      // The actor's native body already supplies physical contacts and actor IDs.
      detachHavokCharacterBodyShape(this.host.plugin, controller);
      this.characters.set(desc.id, { desc: { ...desc }, controller, shape, grounded: false });
    } catch (error) {
      controller?.dispose();
      shape.dispose();
      throw error;
    }
  }

  destroyCharacterController(id: string): void {
    const character = this.characters.get(id);
    if (!character) return;
    character.controller.dispose();
    character.shape.dispose();
    this.characters.delete(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null {
    this.host.flushMutations();
    const character = this.characters.get(id);
    if (!character) return null;
    const body = this.host.bodies.get(character.desc.bodyId);
    if (!body || !Number.isFinite(dt) || dt < 0) return null;
    const start = startPose ? normalizedPhysicsPose(startPose) : undefined;
    if (start) {
      const position = toVector3(start.position);
      if (!body.node.position.equals(position)) {
        // Inherited repositioning is not velocity: large parent changes must
        // not be clipped by Havok's world speed limit. Keep contact membership;
        // only the motor's displacement becomes a native kinematic target.
        const previousPosition = body.node.position.clone();
        body.node.position.copyFrom(position);
        try {
          setHavokBodyPoseBeforeStep(this.host.plugin, body.body);
        } catch (error) {
          body.node.position.copyFrom(previousPosition);
          try {
            setHavokBodyPoseBeforeStep(this.host.plugin, body.body);
          } catch (rollbackError) {
            throw this.host.failMutation(body, new AggregateError(
              [error, rollbackError],
              `Havok Movement pose rollback failed for ${character.desc.bodyId}`,
            ));
          }
          throw error;
        }
      }
      character.controller.setPosition(position);
    }
    // A displacement requested outside a tick (dt = 0, discrete graph events)
    // still moves: the controller integrates it over a nominal step, and the
    // reported velocity is the displacement over the real dt (zero for dt = 0).
    const solveDt = dt >= MIN_CHARACTER_SOLVE_DT ? dt : NOMINAL_CHARACTER_SOLVE_DT;
    character.controller.setVelocity(
      new Vector3(
        translation.x / solveDt,
        translation.y / solveDt,
        translation.z / solveDt,
      ),
    );
    // The controller's casts use its capsule's filter: the actor's own solid
    // collider's layer and mask, as the other backends' solves do.
    const self = [...body.colliders.values()].find((c) => !c.desc.isTrigger &&
      (c.desc.actorId ?? body.desc.actorId) === body.desc.actorId);
    character.shape.filterMembershipMask = self?.desc.layer ?? 0xffffffff;
    character.shape.filterCollideMask = self?.desc.mask ?? 0xffffffff;
    const memberships = new Map<PhysicsShape, number>();
    let grounded: boolean;
    try {
      // CCT casts exclude their private body, not the actor's physical body.
      // Filter the owner's complete compound before collecting any contacts.
      for (const shape of [body.body.shape, ...[...body.colliders.values()].map((c) => c.shape)]) {
        if (!shape || memberships.has(shape)) continue;
        memberships.set(shape, shape.filterMembershipMask);
        shape.filterMembershipMask = 0;
      }
      const support = character.controller.checkSupport(solveDt, this.down);
      character.controller.integrate(solveDt, support, this.zeroGravity);
      grounded = translation.y <= 0 && character.controller.checkSupport(solveDt, this.down).supportedState === CharacterSupportedState.SUPPORTED;
      const snap = character.desc.groundSnapDistance ?? 0.1;
      if (character.grounded && translation.y <= 0 && snap > 0) {
        const position = character.controller.getPosition();
        const hit = this.castHit;
        this.host.plugin.shapeCast({
          shape: character.shape, rotation: Quaternion.Identity(),
          startPosition: position,
          endPosition: position.add(new Vector3(0, -snap - character.desc.offset, 0)),
          shouldHitTriggers: false,
        }, this.castInput, hit);
        if (hit.hasHit && hit.hitNormal.y >= character.controller.maxSlopeCosine) {
          const drop = Math.max(0, hit.hitFraction * (snap + character.desc.offset) - character.desc.offset);
          if (drop <= snap) {
            character.controller.setPosition(position.add(new Vector3(0, -drop, 0)));
            grounded = true;
          }
        }
      }
    } finally {
      for (const [shape, membership] of memberships) shape.filterMembershipMask = membership;
    }
    const pos = character.controller.getPosition();
    const velocity = dt > 0
      ? character.controller.getVelocity().scale(solveDt / dt)
      : { x: 0, y: 0, z: 0 };
    // The solve keeps the start rotation; without one, the body's current rotation.
    const pose = {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: start?.rotation ?? this.host.getBodyTransform(character.desc.bodyId)!.rotation,
    };
    // Kinematic movement uses a native target, which keeps contact membership
    // without the world-membership refresh an explicit teleport performs. It
    // replaces any target set earlier in the frame.
    if (body.desc.motionType === "kinematic") this.host.setBodyTargetTransform(character.desc.bodyId, pose);
    else this.host.teleportBody(character.desc.bodyId, pose);
    // After the teleport, which resets the controller's support state.
    character.grounded = grounded;
    return {
      ...pose,
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      grounded,
    };
  }
}
