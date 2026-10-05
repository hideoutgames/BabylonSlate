import type { Actor, ActorComponent } from "@babylonslate/object-model";
import {
  multiplyQuat,
  parseConstraintProperties,
  rotateQuatVec,
  type ConstraintDesc,
  type PhysicsBackend,
  type Quat,
  type Vec3,
} from "@babylonslate/physics";
import { sameDescriptor } from "./physics-preparation";

type ConstraintProperties = ReturnType<typeof parseConstraintProperties>;

/**
 * A hosted actor's pose in its host's body frame (unit-free position, the
 * rotation its shapes use) and its composed world scale.
 */
export type HostedConstraintFrame = { position: Vec3; rotation: Quat; scale: Vec3 };

/**
 * Collidable statics hosted on a simulated ancestor's body have no body of
 * their own; their joints attach to the host's body at their pose on it.
 */
export type ConstraintHosting = {
  hostOf(actor: Actor): Actor | undefined;
  /** Null when the actor's chain no longer reaches its host. */
  frame(actor: Actor, host: Actor): HostedConstraintFrame | null;
};

/** An endpoint's pose in its body's frame. */
type BodyFrame = { position: Vec3; rotation: Quat };

const IDENTITY_FRAME: BodyFrame = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

/** The body actor of one joint side; null while a hosted chain is broken. */
function constraintEndpoint(
  actor: Actor,
  hosting: ConstraintHosting | undefined,
): { bodyActor: Actor; frame?: HostedConstraintFrame } | null {
  const host = hosting?.hostOf(actor);
  if (!host) return { bodyActor: actor };
  const frame = hosting!.frame(actor, host);
  return frame ? { bodyActor: host, frame } : null;
}

interface AppliedConstraint {
  owner: Actor;
  target: Actor;
  component: ActorComponent;
  descriptor: readonly unknown[];
  constraint: ConstraintDesc;
}

/** Reconcile joints only after both actors' current bodies have been published. */
export class PhysicsConstraintSync {
  private readonly backend: PhysicsBackend;
  private readonly deferUnsupported: boolean;
  private readonly applied = new Map<string, AppliedConstraint>();
  private readonly identities = new WeakMap<ActorComponent, { owner: Actor; id: string }>();
  private readonly propertyScratch: unknown[] = [];
  private readonly appliedScratch: unknown[] = [];
  private readonly properties = new WeakMap<ActorComponent, {
    descriptor: readonly unknown[];
    value: ConstraintProperties;
  }>();

  constructor(
    backend: PhysicsBackend,
    deferUnsupported = false,
  ) {
    this.backend = backend;
    this.deferUnsupported = deferUnsupported;
  }

  sync(options: {
    actors: readonly Actor[];
    actorById: ReadonlyMap<string, Actor>;
    /** World scale of a connected actor; resolved only for constraint endpoints. */
    worldScale: (actor: Actor) => Vec3;
    bodies: ReadonlyMap<string, string>;
    bodyOwners: ReadonlyMap<string, Actor>;
    eligible: (actor: Actor) => boolean;
    hosting?: ConstraintHosting;
  }): void {
    const live = new Set<string>();
    for (const owner of options.actors) {
      if (owner.destroyed || options.actorById.get(owner.guid) !== owner || !options.eligible(owner)) continue;
      for (const component of owner.components) {
        if (component.destroyed || component.owner !== owner || component.classId !== "PhysicsConstraintComponent") continue;
        let identity = this.identities.get(component);
        if (identity?.owner !== owner) {
          identity = { owner, id: `constraint:${JSON.stringify([owner.guid, component.guid])}` };
          this.identities.set(component, identity);
        }
        const { id } = identity;
        if (live.has(id)) continue;
        live.add(id);
        try {
          // Disabling must release a joint even while another authored field is invalid.
          if (component.getVariable("enabled") === false) {
            this.remove(id);
            continue;
          }
          const props = this.readProperties(component);
          if (!props.enabled || !props.targetActorId) {
            this.remove(id);
            continue;
          }
          if (!this.backend.supportsConstraints) {
            if (this.deferUnsupported) continue;
            throw new Error("Constraints require a native physics backend");
          }
          const target = options.actorById.get(props.targetActorId);
          if (target === owner) throw new Error("A constraint must connect two different actors");
          if (target && !target.destroyed && !options.eligible(target)) {
            throw new Error("Connected actors must belong to the same physics world");
          }
          // A hosted endpoint joins its host's body at its pose on that body.
          const a = constraintEndpoint(owner, options.hosting);
          const b = target && !target.destroyed ? constraintEndpoint(target, options.hosting) : null;
          const bodyAId = a && options.bodies.get(a.bodyActor.guid);
          const bodyBId = b && options.bodies.get(b.bodyActor.guid);
          if (!target || !a || !b || !bodyAId || !bodyBId || bodyAId === bodyBId ||
            options.bodyOwners.get(a.bodyActor.guid) !== a.bodyActor ||
            options.bodyOwners.get(b.bodyActor.guid) !== b.bodyActor) {
            // Targets and their bodies may be spawned after the constraint
            // owner. A hosted actor joined to its own host shares its body.
            this.remove(id);
            continue;
          }
          const scaleA = a.frame?.scale ?? options.worldScale(owner);
          const scaleB = b.frame?.scale ?? options.worldScale(target);
          const frameA = a.frame ?? IDENTITY_FRAME;
          const frameB = b.frame ?? IDENTITY_FRAME;
          const descriptor = this.appliedScratch;
          descriptor[0] = props;
          descriptor[1] = bodyAId;
          descriptor[2] = bodyBId;
          descriptor[3] = scaleA.x;
          descriptor[4] = scaleA.y;
          descriptor[5] = scaleA.z;
          descriptor[6] = scaleB.x;
          descriptor[7] = scaleB.y;
          descriptor[8] = scaleB.z;
          writeFrame(descriptor, 9, frameA);
          writeFrame(descriptor, 16, frameB);
          const old = this.applied.get(id);
          if (old?.owner === owner && old.target === target && old.component === component && sameDescriptor(old.descriptor, descriptor)) continue;
          const constraint = describeConstraint(id, bodyAId, bodyBId, props, scaleA, scaleB, a.frame, b.frame);
          // Backend upsert prepares the replacement before releasing a usable joint.
          this.backend.createConstraint(constraint);
          this.applied.set(id, { owner, target, component, descriptor: descriptor.slice(), constraint });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Physics constraint ${component.guid} on actor ${owner.guid}: ${detail}`, { cause: error });
        }
      }
    }
    for (const id of this.applied.keys()) if (!live.has(id)) this.remove(id);
  }

  retireBody(bodyId: string): void {
    for (const [id, state] of this.applied) {
      if (state.constraint.bodyAId === bodyId || state.constraint.bodyBId === bodyId) this.remove(id);
    }
  }

  dispose(): void {
    for (const id of this.applied.keys()) this.remove(id);
  }

  private remove(id: string): void {
    if (!this.applied.has(id)) return;
    this.backend.destroyConstraint(id);
    this.applied.delete(id);
  }

  private readProperties(component: ActorComponent): ConstraintProperties {
    const descriptor = this.propertyScratch;
    let length = 0;
    for (const name of PROPERTY_NAMES) {
      const value = component.getVariable(name);
      descriptor[length++] = value;
      if (value && typeof value === "object") {
        const vector = value as Record<string, unknown>;
        descriptor[length++] = vector.x;
        descriptor[length++] = vector.y;
        descriptor[length++] = vector.z;
        descriptor[length++] = vector.w;
      }
    }
    descriptor.length = length;
    const old = this.properties.get(component);
    if (old && sameDescriptor(old.descriptor, descriptor)) return old.value;
    // Only materialize parsed properties on edits. The scalar descriptor still
    // observes direct map writes and in-place changes to authored vectors.
    const values: Record<string, unknown> = {};
    for (const name of PROPERTY_NAMES) values[name] = component.getVariable(name);
    const value = parseConstraintProperties(values, this.backend.kind);
    this.properties.set(component, { descriptor: descriptor.slice(), value });
    return value;
  }
}

const PROPERTY_NAMES = [
  "kind", "targetActorId", "enabled", "collideConnected", "anchorA", "anchorB",
  "axisA", "axisB", "referenceAxisA", "referenceAxisB", "frameA", "frameB",
  "limitsEnabled", "minAngle", "maxAngle", "distance",
] as const;

function scaledAnchor(anchor: Vec3, scale: Vec3): Vec3 {
  if (![scale.x, scale.y, scale.z].every((value) => Number.isFinite(value) && value !== 0)) {
    throw new Error("Constraint actor scale must be finite and nonzero");
  }
  return { x: anchor.x * scale.x, y: anchor.y * scale.y, z: anchor.z * scale.z };
}

function writeFrame(descriptor: unknown[], offset: number, frame: BodyFrame): void {
  descriptor[offset] = frame.position.x;
  descriptor[offset + 1] = frame.position.y;
  descriptor[offset + 2] = frame.position.z;
  descriptor[offset + 3] = frame.rotation.x;
  descriptor[offset + 4] = frame.rotation.y;
  descriptor[offset + 5] = frame.rotation.z;
  descriptor[offset + 6] = frame.rotation.w;
}

function describeConstraint(
  id: string,
  bodyAId: string,
  bodyBId: string,
  props: ConstraintProperties,
  scaleA: Vec3,
  scaleB: Vec3,
  hostedA: BodyFrame | undefined,
  hostedB: BodyFrame | undefined,
): ConstraintDesc {
  // A hosted endpoint's anchor, axes and frame move into its host's body frame.
  const point = (on: BodyFrame | undefined, p: Vec3): Vec3 => {
    if (!on) return p;
    const offset = rotateQuatVec(on.rotation, p);
    return { x: on.position.x + offset.x, y: on.position.y + offset.y, z: on.position.z + offset.z };
  };
  const axis = (on: BodyFrame | undefined, v: Vec3): Vec3 => on ? rotateQuatVec(on.rotation, v) : v;
  const orient = (on: BodyFrame | undefined, q: Quat): Quat => on ? multiplyQuat(on.rotation, q) : q;
  const base = {
    id, bodyAId, bodyBId,
    // Anchors are authored actor-local points. Orientations are body-local axes;
    // body frames have rotation but no scale, matching the native body contract.
    anchorA: point(hostedA, scaledAnchor(props.anchorA, scaleA)),
    anchorB: point(hostedB, scaledAnchor(props.anchorB, scaleB)),
    collideConnected: props.collideConnected,
  };
  switch (props.kind) {
    case "fixed": return {
      ...base, kind: "fixed", frameA: orient(hostedA, props.frameA), frameB: orient(hostedB, props.frameB),
    };
    case "ballSocket": return { ...base, kind: "ballSocket" };
    case "distance": return { ...base, kind: "distance", distance: props.distance };
    case "hinge": return {
      ...base, kind: "hinge", axisA: axis(hostedA, props.axisA), axisB: axis(hostedB, props.axisB),
      referenceAxisA: axis(hostedA, props.referenceAxisA), referenceAxisB: axis(hostedB, props.referenceAxisB),
      ...(props.limitsEnabled ? { limits: { min: props.minAngle * Math.PI / 180, max: props.maxAngle * Math.PI / 180 } } : {}),
    };
  }
}
