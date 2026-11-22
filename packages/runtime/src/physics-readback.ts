import type { Transform } from "@haptic/core";
import type { PhysicsBackend, PhysicsTransform } from "@haptic/physics";
import type { Actor } from "@haptic/object-model";
import {
  actorParentGuid,
  composeParentChildTransform,
  copyTransform,
  inverseQuaternion,
  multiplyQuaternion,
  relativeTransform,
  rotateVector,
  type ActorTransformMap,
} from "./actor-world-transform";
import { PhysicsCompositionScratch, physicsWorldTransforms } from "./physics-preparation";

/** What `PhysicsReadback` uses of `PhysicsWorldSync`. */
export interface PhysicsReadbackHost {
  readonly backend: Pick<PhysicsBackend, "kind" | "readBodyTransform" | "didBodyMoveLastStep">;
  /** Body ids by actor guid for simulated (dynamic + kinematic) bodies only. */
  readonly simulatedBodies: ReadonlyMap<string, string>;
  /** Actor guids whose current body is dynamic (eligible for unchanged/sleeping skip). */
  readonly dynamicBodyActors: ReadonlySet<string>;
  /**
   * Dynamic bodies read back this step even when they did not move: their actor or an ancestor changed since the
   * last step, so their actor-local pose must be recomputed against the new chain.
   */
  readonly forcedReadback: ReadonlySet<string>;
  /** The actor each body was created for, by actor guid. */
  readonly bodyOwners: ReadonlyMap<string, Actor>;
  /** Physics eligibility; a whole-world recomposition calls it unbound. */
  readonly eligible: (actor: Actor) => boolean;
  findLiveActor(guid: string): Actor | undefined;
  candidateActors(): readonly Actor[];
  /** The last pre-step composition. Read it at each use: dispose replaces the map. */
  passTransforms(): ActorTransformMap;
  /** Keep the cached pre-step world pose fresh for a stepped body's position and rotation. */
  updatePassBodyPose?(actorId: string, pose: PhysicsTransform): void;
}

/** Writes post-step native body poses back to their actors as actor-local transforms. */
export class PhysicsReadback {
  private readonly host: PhysicsReadbackHost;
  private readonly bodyPoses = new Map<string, PhysicsTransform>();
  /** Pose objects the readback fills each step, one per simulated body; they are never kept past it. */
  private readonly posePool: PhysicsTransform[] = [];
  private readonly readbackWorld = new Map<string, Transform>();
  /** Parented dynamic bodies skipped on first scan; re-checked iff any awake body moved. */
  private readonly deferredActorIds: string[] = [];
  private readonly deferredBodyIds: string[] = [];
  // `worldTransforms` is rewritten in place by the next pre-step pass; a
  // readback recomposition has its own so it never overwrites that map.
  private readonly recomposition = new PhysicsCompositionScratch();

  constructor(host: PhysicsReadbackHost) {
    this.host = host;
  }

  /**
   * `findLiveActor` for the readback that follows a step. A step hook can destroy an actor and spawn another under
   * its guid before readback; a guid whose body still belongs to the destroyed actor answers as nobody, as the
   * pre-step index did, so the replacement is never placed by (or composed under) the old body's pose.
   */
  private readonly findReadbackActor = (guid: string): Actor | undefined => {
    const live = this.host.findLiveActor(guid);
    const owner = this.host.bodyOwners.get(guid);
    return owner !== undefined && live !== owner ? undefined : live;
  };

  /**
   * Gather every simulated native pose, then write actor-local poses. Static
   * bodies are skipped: they follow their actor, so authored depth, tilt and
   * quaternions stay as written and a static child keeps its local pose under a
   * moving parent. Sleeping/unchanged dynamic bodies are skipped when
   * `!recompose`, no ancestor body moved during the step and neither the actor
   * nor any ancestor changed since the last step (`forcedReadback`). An unparented body
   * copies its native pose without composition; a parented body resolves only
   * its own ancestor chain against post-step parent body poses, where a static
   * ancestor composes under its own parent like a nonphysics actor. With
   * `recompose`, the whole world is recomposed and revalidated instead.
   */
  readBack(recompose: boolean): void {
    if (!recompose && this.host.simulatedBodies.size === 0) return;
    const poses = this.bodyPoses;
    // Both are emptied as the last readback ends: clearing an empty one would only make it a new table.
    if (poses.size) poses.clear();
    if (this.readbackWorld.size) this.readbackWorld.clear();
    this.deferredActorIds.length = 0;
    this.deferredBodyIds.length = 0;
    this.recomposePass = recompose;
    try {
      // Poses are read into pooled objects: every consumer below copies the values and `poses` is cleared on exit.
      this.posesUsed = 0;
      this.host.simulatedBodies.forEach(this.readPose);
      if (this.deferredActorIds.length > 0 && poses.size > 0) {
        for (let i = 0; i < this.deferredActorIds.length; i++) {
          const actorId = this.deferredActorIds[i]!;
          const actor = this.host.bodyOwners.get(actorId);
          if (!actor || actor.destroyed || !this.hasMovedAncestor(actor)) continue;
          const bodyId = this.deferredBodyIds[i]!;
          const pose = (this.posePool[this.posesUsed] ??= {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          });
          if (!this.host.backend.readBodyTransform(bodyId, pose)) continue;
          poses.set(actorId, pose);
          this.posesUsed++;
        }
      }
      this.world = recompose
        ? physicsWorldTransforms(
            this.host.candidateActors(),
            this.findReadbackActor,
            this.host.backend.kind,
            this.host.eligible,
            poses,
            this.recomposition,
          )
        : undefined;
      poses.forEach(this.writePose);
    } finally {
      this.world = undefined;
      this.recomposePass = false;
      this.deferredActorIds.length = 0;
      this.deferredBodyIds.length = 0;
      poses.clear();
      if (this.readbackWorld.size) this.readbackWorld.clear();
    }
  }

  // The readback's steps for each body, made once and handed to `forEach`: a `for...of` over a Map makes a pair
  // array per entry, for every body, every step.
  /** Pool entries `readPose` has filled this readback. */
  private posesUsed = 0;
  /** Whether this readback is a whole-world recomposition pass (`readPose` must read every body). */
  private recomposePass = false;
  /** This readback's whole-world recomposition, while it writes poses (`writePose`). */
  private world: ActorTransformMap | undefined;

  private readonly readPose = (bodyId: string, actorId: string): void => {
    const host = this.host;
    // A body whose actor left the World during the step (or was replaced under its guid) has nothing to write back.
    const owner = host.bodyOwners.get(actorId);
    if (!owner || host.findLiveActor(actorId) !== owner) return;
    if (
      !this.recomposePass &&
      host.dynamicBodyActors.has(actorId) &&
      host.backend.didBodyMoveLastStep !== undefined &&
      !host.forcedReadback.has(actorId) &&
      !host.backend.didBodyMoveLastStep(bodyId)
    ) {
      if (actorParentGuid(owner) !== null) {
        this.deferredActorIds.push(actorId);
        this.deferredBodyIds.push(bodyId);
      }
      return;
    }
    const pose = (this.posePool[this.posesUsed] ??= { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
    if (!host.backend.readBodyTransform(bodyId, pose)) return;
    this.bodyPoses.set(actorId, pose);
    this.posesUsed++;
  };

  /** True if any live ancestor of `actor` was read back as moved in this step. */
  private hasMovedAncestor(actor: Actor): boolean {
    let parentId = actorParentGuid(actor);
    // Depth bound guards against any malformed cycle (pre-step validation prevents cycles in normal ticks).
    for (let depth = 0; parentId !== null && depth < 1024; depth++) {
      if (this.bodyPoses.has(parentId)) return true;
      const parent = this.findReadbackActor(parentId);
      if (!parent || parent.destroyed) return false;
      parentId = actorParentGuid(parent);
    }
    return false;
  }

  private readonly writePose = (transform: PhysicsTransform, actorId: string): void => {
    const actor = this.host.bodyOwners.get(actorId);
    if (!actor || actor.destroyed) return;
    const world = this.world;
    let local: PhysicsTransform;
    if (world) local = actorLocalPhysicsTransform(transform, actor, world);
    else {
      const parentId = actorParentGuid(actor);
      const parent = parentId ? this.findReadbackActor(parentId) : undefined;
      // A body's resolved pose never reads its own local position or
      // rotation, so writing earlier bodies cannot change a later ancestor.
      local =
        parent && !parent.destroyed
          ? localPhysicsTransform(transform, this.readbackPose(parent), actor.transform)
          : transform;
    }
    actor.writeTransformPoseFromPhysics(local.position, local.rotation);
    this.host.updatePassBodyPose?.(actorId, transform);
  };

  /**
   * Post-step world pose of a readback ancestor: a simulated body's native pose
   * with its composed scale, otherwise (nonphysics and static actors) the
   * authored composition under its resolved parent. A chain without simulated
   * bodies reuses this tick's pre-step composition,
   * whose inputs are unchanged and were already validated for cycles and shear:
   * without hook scripts, only Movement motors write poses after composition,
   * and those actors are bodies whose descendants recompose here.
   */
  private readbackPose(actor: Actor): Transform {
    const cached = this.readbackWorld.get(actor.guid);
    if (cached) return cached;
    const parentId = actorParentGuid(actor);
    const parent = parentId ? this.findReadbackActor(parentId) : undefined;
    const ancestor =
      parent && !parent.destroyed ? this.readbackPose(parent) : undefined;
    const body = this.bodyPoses.get(actor.guid);
    const authored = this.host.passTransforms().get(actor.guid);
    const authoredParent =
      ancestor && parent ? this.host.passTransforms().get(parent.guid) : undefined;
    let transform: Transform;
    if (body) {
      transform = {
        position: { ...body.position },
        rotation: { ...body.rotation },
        // Scale is unchanged by the step: reuse the pre-step composition,
        // which predates this readback's local rotation writes.
        scale: authored
          ? { ...authored.scale }
          : ancestor
            ? composeParentChildTransform(ancestor, actor.transform).scale
            : { ...actor.transform.scale },
      };
    } else if (authored && ancestor === authoredParent) {
      transform = authored;
    } else {
      transform = ancestor
        ? composeParentChildTransform(ancestor, actor.transform)
        : copyTransform(actor.transform);
    }
    this.readbackWorld.set(actor.guid, transform);
    return transform;
  }

  /** What `PhysicsWorldSync.dispose` releases; the recomposition scratch stays. */
  clear(): void {
    this.bodyPoses.clear();
    this.posePool.length = 0;
    this.readbackWorld.clear();
    this.deferredActorIds.length = 0;
    this.deferredBodyIds.length = 0;
  }
}

export function actorLocalPhysicsTransform(
  world: PhysicsTransform,
  actor: Actor,
  transforms: ActorTransformMap,
): PhysicsTransform {
  const parentId = actorParentGuid(actor);
  const parentWorld = parentId ? transforms.get(parentId) : undefined;
  return parentWorld ? localPhysicsTransform(world, parentWorld, actor.transform) : world;
}

/**
 * A body's world pose as the actor's local position and rotation. The actor
 * keeps its own scale, so its composed world scale completes the body pose,
 * and a nonuniform or mirrored parent inverts through the authored matrices.
 */
function localPhysicsTransform(
  world: PhysicsTransform,
  parentWorld: Transform,
  local: Transform,
): PhysicsTransform {
  const { x: sx, y: sy, z: sz } = parentWorld.scale;
  if (!(sx === sy && sy === sz)) {
    const relative = relativeTransform(parentWorld, {
      position: world.position,
      rotation: world.rotation,
      scale: composeParentChildTransform(parentWorld, local).scale,
    }, local);
    if (relative) return { position: relative.position, rotation: relative.rotation };
  }
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

function divideScale(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
}
