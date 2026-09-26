import type { Actor, ActorComponent } from "@babylonslate/object-model";
import {
  parseConstraintProperties,
  type ConstraintDesc,
  type PhysicsBackend,
  type Vec3,
} from "@babylonslate/physics";
import type { ActorTransformMap } from "./actor-world-transform";
import { sameDescriptor } from "./physics-preparation";

type ConstraintProperties = ReturnType<typeof parseConstraintProperties>;

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
    transforms: ActorTransformMap;
    bodies: ReadonlyMap<string, string>;
    bodyOwners: ReadonlyMap<string, Actor>;
    eligible: (actor: Actor) => boolean;
  }): void {
    const live = new Set<string>();
    for (const owner of options.actors) {
      if (owner.destroyed || options.actorById.get(owner.guid) !== owner || !options.eligible(owner)) continue;
      for (const component of owner.components) {
        if (component.destroyed || component.owner !== owner || component.classId !== "PhysicsConstraintComponent") continue;
        const id = `constraint:${JSON.stringify([owner.guid, component.guid])}`;
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
          const bodyAId = options.bodies.get(owner.guid);
          const bodyBId = target && options.bodies.get(target.guid);
          if (!target || target.destroyed || !bodyAId || !bodyBId ||
            options.bodyOwners.get(owner.guid) !== owner || options.bodyOwners.get(target.guid) !== target) {
            // Targets and their bodies may be spawned after the constraint owner.
            this.remove(id);
            continue;
          }
          const scaleA = options.transforms.get(owner.guid)?.scale ?? owner.transform.scale;
          const scaleB = options.transforms.get(target.guid)?.scale ?? target.transform.scale;
          const descriptor = [props, bodyAId, bodyBId, scaleA.x, scaleA.y, scaleA.z, scaleB.x, scaleB.y, scaleB.z];
          const old = this.applied.get(id);
          if (old?.owner === owner && old.target === target && old.component === component && sameDescriptor(old.descriptor, descriptor)) continue;
          const constraint = describeConstraint(id, bodyAId, bodyBId, props, scaleA, scaleB);
          // Backend upsert prepares the replacement before releasing a usable joint.
          this.backend.createConstraint(constraint);
          this.applied.set(id, { owner, target, component, descriptor, constraint });
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
    const values = Object.fromEntries(PROPERTY_NAMES.map((name) => [name, component.getVariable(name)]));
    const descriptor: unknown[] = [];
    for (const name of PROPERTY_NAMES) {
      const value: unknown = values[name];
      descriptor.push(value);
      if (value && typeof value === "object") {
        const vector = value as Record<string, unknown>;
        descriptor.push(vector.x, vector.y, vector.z, vector.w);
      }
    }
    const old = this.properties.get(component);
    if (old && sameDescriptor(old.descriptor, descriptor)) return old.value;
    const value = parseConstraintProperties(values, this.backend.kind);
    this.properties.set(component, { descriptor, value });
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

function describeConstraint(
  id: string,
  bodyAId: string,
  bodyBId: string,
  props: ConstraintProperties,
  scaleA: Vec3,
  scaleB: Vec3,
): ConstraintDesc {
  const base = {
    id, bodyAId, bodyBId,
    // Anchors are authored actor-local points. Orientations are body-local axes;
    // body frames have rotation but no scale, matching the native body contract.
    anchorA: scaledAnchor(props.anchorA, scaleA),
    anchorB: scaledAnchor(props.anchorB, scaleB),
    collideConnected: props.collideConnected,
  };
  switch (props.kind) {
    case "fixed": return { ...base, kind: "fixed", frameA: props.frameA, frameB: props.frameB };
    case "ballSocket": return { ...base, kind: "ballSocket" };
    case "distance": return { ...base, kind: "distance", distance: props.distance };
    case "hinge": return {
      ...base, kind: "hinge", axisA: props.axisA, axisB: props.axisB,
      referenceAxisA: props.referenceAxisA, referenceAxisB: props.referenceAxisB,
      ...(props.limitsEnabled ? { limits: { min: props.minAngle * Math.PI / 180, max: props.maxAngle * Math.PI / 180 } } : {}),
    };
  }
}
