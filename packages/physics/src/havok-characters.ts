import type {
  HavokPhysicsWithBindings,
  HP_CollectorId,
  HP_ShapeId,
  HP_WorldId,
} from "@babylonjs/havok";
import type { CharacterControllerDesc, CharacterMovementResult, PhysicsTransform, Vec3 } from "./types";
import { normalizedPhysicsPose } from "./collider-validation";
import {
  colliderShapes,
  releaseHavokShape,
  setShapeMembershipMask,
  type BodyRecord,
} from "./havok-records";
import {
  checked,
  checkedValue,
  IDENTITY_HAVOK_QUAT,
  vec3Cross,
  vec3Dot,
} from "./havok-wasm-memory";

type CharacterRecord = {
  desc: CharacterControllerDesc;
  shape: HP_ShapeId;
  maxSlopeCosine: number;
  position: Vec3;
  grounded: boolean;
};

/** Max slide iterations per `moveCharacter` call. */
const MAX_SLIDE_ITERATIONS = 6;
const MOVE_EPS = 1e-6;
const SUPPORT_PROBE_EXTRA = 0.005;

/** What character movement reads from and calls on the backend that owns the world. */
export interface HavokCharacterHost {
  readonly havok: HavokPhysicsWithBindings;
  readonly worldId: HP_WorldId;
  readonly bodies: ReadonlyMap<string, BodyRecord>;
  flushMutations(): void;
  failMutation(record: BodyRecord, failure: Error): Error;
  setBodyPoseBeforeStep(record: BodyRecord): void;
  getBodyTransform(bodyId: string): PhysicsTransform | null;
  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void;
  teleportBody(bodyId: string, transform: PhysicsTransform): void;
}

/**
 * Direct Havok WASM character controllers: owns one native capsule `HP_ShapeId` per controller (zero extra bodies or
 * Babylon `TransformNode`s) and solves depenetration, collide-and-slide, slope limits, and ground snapping directly
 * through `HP_World_ShapeProximityWithCollector` and `HP_World_ShapeCastWithCollector`.
 */
export class HavokCharacters {
  private readonly host: HavokCharacterHost;
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly proximityCollector: HP_CollectorId;
  private readonly castCollector: HP_CollectorId;

  constructor(host: HavokCharacterHost) {
    this.host = host;
    this.proximityCollector = checkedValue(
      host.havok,
      host.havok.HP_QueryCollector_Create(16),
      "character proximity collector creation",
    );
    this.castCollector = checkedValue(
      host.havok,
      host.havok.HP_QueryCollector_Create(16),
      "character cast collector creation",
    );
  }

  /** Disposes the controllers driving a body that is being destroyed. */
  destroyForBody(bodyId: string): void {
    for (const [id, character] of this.characters) {
      if (character.desc.bodyId === bodyId) {
        releaseHavokShape(this.host.havok, character.shape);
        this.characters.delete(id);
      }
    }
  }

  /** Moves the controllers driving a teleported body to its new position; the teleport resets their support state. */
  bodyTeleported(bodyId: string, position: Vec3): void {
    for (const character of this.characters.values()) {
      if (character.desc.bodyId === bodyId) {
        character.position.x = position.x;
        character.position.y = position.y;
        character.position.z = position.z;
        character.grounded = false;
      }
    }
  }

  /** Disposes every controller, its capsule shape, and shared query collectors. */
  dispose(): void {
    for (const character of this.characters.values()) {
      releaseHavokShape(this.host.havok, character.shape);
    }
    this.characters.clear();
    if (this.proximityCollector[0] !== 0n) {
      this.host.havok.HP_QueryCollector_Release(this.proximityCollector);
    }
    if (this.castCollector[0] !== 0n) {
      this.host.havok.HP_QueryCollector_Release(this.castCollector);
    }
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const record = this.host.bodies.get(desc.bodyId);
    if (!record) return;
    if (this.characters.has(desc.id)) this.destroyCharacterController(desc.id);
    const radius = desc.radius ?? 0.4;
    const height = Math.max(desc.height ?? 1.8, radius * 2);
    const halfSegment = height / 2 - radius;
    const shape = checkedValue(
      this.host.havok,
      this.host.havok.HP_Shape_CreateCapsule([0, halfSegment, 0], [0, -halfSegment, 0], radius),
      "character capsule creation",
    );
    this.characters.set(desc.id, {
      desc: { ...desc },
      shape,
      maxSlopeCosine: Math.cos(((desc.maxSlopeAngle ?? 50) * Math.PI) / 180),
      position: { ...record.pose.position },
      grounded: false,
    });
  }

  destroyCharacterController(id: string): void {
    const character = this.characters.get(id);
    if (!character) return;
    releaseHavokShape(this.host.havok, character.shape);
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
      const p = start.position;
      if (
        body.pose.position.x !== p.x ||
        body.pose.position.y !== p.y ||
        body.pose.position.z !== p.z
      ) {
        const previousPosition = { ...body.pose.position };
        body.pose.position.x = p.x;
        body.pose.position.y = p.y;
        body.pose.position.z = p.z;
        try {
          this.host.setBodyPoseBeforeStep(body);
        } catch (error) {
          body.pose.position.x = previousPosition.x;
          body.pose.position.y = previousPosition.y;
          body.pose.position.z = previousPosition.z;
          try {
            this.host.setBodyPoseBeforeStep(body);
          } catch (rollbackError) {
            throw this.host.failMutation(
              body,
              new AggregateError(
                [error, rollbackError],
                `Havok Movement pose rollback failed for ${character.desc.bodyId}`,
              ),
            );
          }
          throw error;
        }
      }
      character.position.x = p.x;
      character.position.y = p.y;
      character.position.z = p.z;
    }

    const havok = this.host.havok;
    const worldId = this.host.worldId;
    const keepDistance = Math.max(0, character.desc.offset);
    const startX = character.position.x;
    const startY = character.position.y;
    const startZ = character.position.z;

    // Filter the controller's capsule using the actor's own solid collider layer & mask.
    const self = [...body.colliders.values()].find(
      (c) => !c.desc.isTrigger && (c.desc.actorId ?? body.desc.actorId) === body.desc.actorId,
    );
    const layer = (self?.desc.layer ?? 0xffffffff) >>> 0;
    const mask = (self?.desc.mask ?? 0xffffffff) >>> 0;
    checked(havok, havok.HP_Shape_SetFilterInfo(character.shape, [layer, mask]), "character capsule filter");

    // Mask the actor's own compound shapes so self-collision is excluded even when hosted shapes exist.
    const memberships = new Map<HP_ShapeId, number>();
    let grounded = false;
    let posX = startX;
    let posY = startY;
    let posZ = startZ;

    try {
      const ownShapes: HP_ShapeId[] = [];
      if (body.attachedShape) ownShapes.push(body.attachedShape);
      for (const collider of body.colliders.values()) {
        for (const s of colliderShapes(collider)) ownShapes.push(s);
      }
      for (const shape of ownShapes) {
        if (memberships.has(shape)) continue;
        memberships.set(shape, setShapeMembershipMask(havok, shape, 0));
      }

      // 1. Depenetration: resolve any existing overlap within `keepDistance`.
      for (let depen = 0; depen < 3; depen++) {
        checked(
          havok,
          havok.HP_World_ShapeProximityWithCollector(worldId, this.proximityCollector, [
            character.shape,
            [posX, posY, posZ],
            IDENTITY_HAVOK_QUAT,
            keepDistance,
            false,
            body.hpBodyId,
          ]),
          "character depenetration proximity",
        );
        const hits = checkedValue(
          havok,
          havok.HP_QueryCollector_GetNumHits(this.proximityCollector),
          "character depenetration count",
        );
        if (hits <= 0) break;
        let deepestDist = keepDistance;
        let pushNx = 0, pushNy = 0, pushNz = 0;
        for (let i = 0; i < hits; i++) {
          const [dist, , hitWorld] = checkedValue(
            havok,
            havok.HP_QueryCollector_GetShapeProximityResult(this.proximityCollector, i),
            "character depenetration result",
          );
          if (dist < deepestDist) {
            deepestDist = dist;
            pushNx = hitWorld[4][0];
            pushNy = hitWorld[4][1];
            pushNz = hitWorld[4][2];
          }
        }
        const push = keepDistance - deepestDist;
        if (push <= 1e-5) break;
        posX += pushNx * push;
        posY += pushNy * push;
        posZ += pushNz * push;
      }

      // 2. Iterative collide-and-slide across up to MAX_SLIDE_ITERATIONS planes.
      let remX = Number.isFinite(translation.x) ? translation.x : 0;
      let remY = Number.isFinite(translation.y) ? translation.y : 0;
      let remZ = Number.isFinite(translation.z) ? translation.z : 0;
      const planes: Vec3[] = [];
      let touchedWalkable = false;

      for (let iter = 0; iter < MAX_SLIDE_ITERATIONS; iter++) {
        const len = Math.hypot(remX, remY, remZ);
        if (len <= MOVE_EPS) break;

        checked(
          havok,
          havok.HP_World_ShapeCastWithCollector(worldId, this.castCollector, [
            character.shape,
            IDENTITY_HAVOK_QUAT,
            [posX, posY, posZ],
            [posX + remX, posY + remY, posZ + remZ],
            false,
            body.hpBodyId,
          ]),
          "character slide cast",
        );
        const numHits = checkedValue(
          havok,
          havok.HP_QueryCollector_GetNumHits(this.castCollector),
          "character slide hit count",
        );
        if (numHits <= 0) {
          posX += remX;
          posY += remY;
          posZ += remZ;
          break;
        }

        // Collectors with capacity > 1 are not guaranteed sorted; pick the earliest blocking hit.
        let minFrac = 2;
        let hitNx = 0, hitNy = 0, hitNz = 0;
        for (let i = 0; i < numHits; i++) {
          const [fraction, , hitWorld] = checkedValue(
            havok,
            havok.HP_QueryCollector_GetShapeCastResult(this.castCollector, i),
            "character slide cast result",
          );
          if (fraction < minFrac) {
            minFrac = fraction;
            hitNx = hitWorld[4][0];
            hitNy = hitWorld[4][1];
            hitNz = hitWorld[4][2];
          }
        }
        if (minFrac > 1) {
          posX += remX;
          posY += remY;
          posZ += remZ;
          break;
        }

        const dirX = remX / len;
        const dirY = remY / len;
        const dirZ = remZ / len;
        const intoDot = -(dirX * hitNx + dirY * hitNy + dirZ * hitNz);
        const skinBackoff = intoDot > 1e-4 ? keepDistance / intoDot : keepDistance;
        const advance = Math.max(0, minFrac * len - skinBackoff);
        posX += dirX * advance;
        posY += dirY * advance;
        posZ += dirZ * advance;

        // Remaining displacement after advancing by `advance` (keeps full tangential slide when already at `keepDistance`).
        const leftover = Math.max(0, len - advance);
        remX = dirX * leftover;
        remY = dirY * leftover;
        remZ = dirZ * leftover;

        if (hitNy >= character.maxSlopeCosine) {
          touchedWalkable = true;
        } else if (hitNy > 0 && translation.y <= 0) {
          // Steep slope: block upward climbing by treating it as a vertical wall.
          const horiz = Math.hypot(hitNx, hitNz);
          if (horiz > 1e-5) {
            hitNx /= horiz;
            hitNy = 0;
            hitNz /= horiz;
          }
        }

        const planeNormal: Vec3 = { x: hitNx, y: hitNy, z: hitNz };
        planes.push(planeNormal);

        // Clip remaining displacement against the active constraint planes.
        const dot = remX * hitNx + remY * hitNy + remZ * hitNz;
        if (dot < 0) {
          remX -= hitNx * dot;
          remY -= hitNy * dot;
          remZ -= hitNz * dot;
        }

        // If two non-parallel planes are active, project along their crease line when penetrating an earlier plane.
        if (planes.length >= 2) {
          let blocked = false;
          for (let p = 0; p < planes.length - 1; p++) {
            const prev = planes[p]!;
            if (remX * prev.x + remY * prev.y + remZ * prev.z < -MOVE_EPS) {
              const crease = vec3Cross(prev, planeNormal);
              const creaseLen = Math.hypot(crease.x, crease.y, crease.z);
              if (creaseLen > 1e-5) {
                const cx = crease.x / creaseLen;
                const cy = crease.y / creaseLen;
                const cz = crease.z / creaseLen;
                const proj = remX * cx + remY * cy + remZ * cz;
                remX = cx * proj;
                remY = cy * proj;
                remZ = cz * proj;
                // Check against a third plane: corner lock stops motion cleanly.
                for (let k = 0; k < planes.length; k++) {
                  if (k === p || k === planes.length - 1) continue;
                  const third = planes[k]!;
                  if (vec3Dot({ x: remX, y: remY, z: remZ }, third) < -MOVE_EPS) {
                    blocked = true;
                    break;
                  }
                }
              } else {
                blocked = true;
              }
              break;
            }
          }
          if (blocked) break;
        }
      }

      // 3. Support check: grounded when moving down/level and touching or immediately above a walkable surface.
      if (translation.y <= 0) {
        if (touchedWalkable) {
          grounded = true;
        } else {
          const probeDist = keepDistance + SUPPORT_PROBE_EXTRA;
          checked(
            havok,
            havok.HP_World_ShapeCastWithCollector(worldId, this.castCollector, [
              character.shape,
              IDENTITY_HAVOK_QUAT,
              [posX, posY, posZ],
              [posX, posY - probeDist, posZ],
              false,
              body.hpBodyId,
            ]),
            "character support cast",
          );
          const supportHits = checkedValue(
            havok,
            havok.HP_QueryCollector_GetNumHits(this.castCollector),
            "character support count",
          );
          let bestFrac = 2;
          let bestNy = -1;
          for (let i = 0; i < supportHits; i++) {
            const [fraction, , hitWorld] = checkedValue(
              havok,
              havok.HP_QueryCollector_GetShapeCastResult(this.castCollector, i),
              "character support result",
            );
            const ny = hitWorld[4][1];
            // Ignore vertical side-wall or ceiling grazing contacts so hugging a wall never masks the floor underneath.
            if (ny <= 1e-3) continue;
            if (fraction < bestFrac) {
              bestFrac = fraction;
              bestNy = ny;
            }
          }
          if (bestFrac <= 1 && bestNy >= character.maxSlopeCosine) {
            grounded = true;
          }
        }
      }

      // 4. Ground snap down short ledges when previously grounded and moving down/level.
      const snap = character.desc.groundSnapDistance ?? 0.1;
      if (character.grounded && translation.y <= 0 && snap > 0) {
        const snapCastDist = snap + keepDistance;
        checked(
          havok,
          havok.HP_World_ShapeCastWithCollector(worldId, this.castCollector, [
            character.shape,
            IDENTITY_HAVOK_QUAT,
            [posX, posY, posZ],
            [posX, posY - snapCastDist, posZ],
            false,
            body.hpBodyId,
          ]),
          "character ground snap cast",
        );
        const snapHits = checkedValue(
          havok,
          havok.HP_QueryCollector_GetNumHits(this.castCollector),
          "character ground snap count",
        );
        let bestFrac = 2;
        let bestNy = -1;
        for (let i = 0; i < snapHits; i++) {
          const [fraction, , hitWorld] = checkedValue(
            havok,
            havok.HP_QueryCollector_GetShapeCastResult(this.castCollector, i),
            "character ground snap result",
          );
          const ny = hitWorld[4][1];
          // Ignore vertical side-wall or ceiling grazing contacts so stepping off a ledge beside a wall still snaps.
          if (ny <= 1e-3) continue;
          if (fraction < bestFrac) {
            bestFrac = fraction;
            bestNy = ny;
          }
        }
        if (bestFrac <= 1 && bestNy >= character.maxSlopeCosine) {
          const drop = Math.max(0, bestFrac * snapCastDist - keepDistance);
          if (drop <= snap) {
            posY -= drop;
            grounded = true;
          }
        }
      }
    } finally {
      for (const [shape, membership] of memberships) {
        setShapeMembershipMask(havok, shape, membership);
      }
    }

    character.position.x = posX;
    character.position.y = posY;
    character.position.z = posZ;

    const velocity: Vec3 = dt > 0
      ? {
          x: (posX - startX) / dt,
          y: (posY - startY) / dt,
          z: (posZ - startZ) / dt,
        }
      : { x: 0, y: 0, z: 0 };

    const pose: PhysicsTransform = {
      position: { x: posX, y: posY, z: posZ },
      rotation: start?.rotation ?? this.host.getBodyTransform(character.desc.bodyId)!.rotation,
    };

    if (body.desc.motionType === "kinematic") this.host.setBodyTargetTransform(character.desc.bodyId, pose);
    else this.host.teleportBody(character.desc.bodyId, pose);
    // After teleport, which resets the controller's support state.
    character.grounded = grounded;

    return {
      ...pose,
      velocity,
      grounded,
    };
  }
}
