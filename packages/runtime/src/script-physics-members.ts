import type { Vec3 } from "@haptic/core";
import type { Actor } from "@haptic/object-model";
import type { HostContextMembers } from "./script-context-types";
import { asActor, finiteVector } from "./script-host-helpers";
import type { ScriptHostServices } from "./script-host-services";

type PhysicsMemberKey =
  | "physicsVelocity" | "setPhysicsVelocity" | "addForce" | "addTorque" | "setMotionType" | "getMotionType"
  | "setActorCollisionEnabled" | "isActorCollisionEnabled";

const DEGREES = 180 / Math.PI;
const ZERO = (): Vec3 => ({ x: 0, y: 0, z: 0 });
/** Set Motion Type's enum members by the Rigid Body `motionType` they write. */
const MOTION_TYPES: Readonly<Record<string, string>> = { Static: "static", Kinematic: "kinematic", Dynamic: "dynamic" };

const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function liveActor(value: unknown): Actor | null {
  const actor = asActor(value);
  return actor && !actor.destroyed ? actor : null;
}

/**
 * Two opposite impulses whose couple about `center` is the angular impulse `angular`: `J = L × u` at `center + u/2`
 * and `-J` at `center - u/2`, for a unit `u` perpendicular to `L`, add no linear momentum and `u × J = L` of angular
 * momentum. Every backend's impulse at a point already applies the body's inertia; 2D keeps `u` in the plane.
 */
export function torqueCouple(angular: Vec3, center: Vec3): { impulse: Vec3; at: Vec3; opposite: Vec3 } | null {
  const length = Math.hypot(angular.x, angular.y, angular.z);
  if (!(length > 0)) return null;
  // The world axis least aligned with L keeps L × axis well away from zero.
  const ax = Math.abs(angular.x), ay = Math.abs(angular.y), az = Math.abs(angular.z);
  const axis = ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const perpendicular = cross(angular, axis);
  const u = scale(perpendicular, 1 / Math.hypot(perpendicular.x, perpendicular.y, perpendicular.z));
  const impulse = cross(angular, u);
  return { impulse, at: add(center, scale(u, 0.5)), opposite: add(center, scale(u, -0.5)) };
}

/** Rigid Body velocity, force, torque, Motion Type and actor collision (`scripting-nodes` physics group). */
export function createPhysicsMembers(services: ScriptHostServices): Pick<HostContextMembers, PhysicsMemberKey> {
  return {
    physicsVelocity: (actor, angular) => {
      const target = liveActor(actor);
      const velocity = target ? services.physicsVelocity?.(target) : null;
      if (!velocity) return ZERO();
      return angular === true ? scale(velocity.angular, DEGREES) : { ...velocity.linear };
    },
    setPhysicsVelocity: (actor, angular, value, addToCurrent) => {
      const target = liveActor(actor);
      const velocity = finiteVector(value as never, 0);
      if (!target || !velocity) return;
      const isAngular = angular === true;
      // Angular velocity is authored in degrees per second; the backend takes radians.
      let next = isAngular ? scale(velocity, 1 / DEGREES) : velocity;
      if (addToCurrent === true) {
        const current = services.physicsVelocity?.(target);
        if (!current) return;
        next = add(isAngular ? current.angular : current.linear, next);
      }
      services.setPhysicsVelocity?.(target, isAngular ? { angular: next } : { linear: next });
    },
    addForce: (actor, force, deltaSeconds) => {
      const target = liveActor(actor);
      const vector = finiteVector(force as never, 0);
      const dt = Number(deltaSeconds);
      // A force acts for this tick's game time: impulse = force × Delta Seconds.
      if (!target || !vector || !(dt > 0)) return;
      services.addImpulse?.(target, scale(vector, dt), 1);
    },
    addTorque: (actor, torque, deltaSeconds) => {
      const target = liveActor(actor);
      const vector = finiteVector(torque as never, 0);
      const dt = Number(deltaSeconds);
      const center = target ? services.physicsVelocity?.(target)?.centerOfMass : null;
      if (!target || !vector || !center || !(dt > 0)) return;
      const couple = torqueCouple(scale(vector, dt), center);
      if (!couple) return;
      services.addImpulseAtPoint?.(target, couple.impulse, couple.at);
      services.addImpulseAtPoint?.(target, scale(couple.impulse, -1), couple.opposite);
    },
    setMotionType: (actor, motionType) => {
      const target = liveActor(actor);
      const value = typeof motionType === "string" ? MOTION_TYPES[motionType] : undefined;
      const body = target?.components.find((component) => component.classId === "RigidBodyComponent" && !component.destroyed);
      if (!body || !value || body.getVariable("motionType") === value) return;
      body.setVariable("motionType", value);
      services.refreshComponent?.(body, "motionType");
    },
    getMotionType: (actor) => {
      const body = liveActor(actor)?.components.find((component) => component.classId === "RigidBodyComponent" && !component.destroyed);
      const value = body?.getVariable("motionType");
      return Object.keys(MOTION_TYPES).find((member) => MOTION_TYPES[member] === value) ?? "Static";
    },
    setActorCollisionEnabled: (actor, enabled) => {
      const target = liveActor(actor);
      if (target) services.setActorCollisionEnabled?.(target, enabled === true);
    },
    isActorCollisionEnabled: (actor) => {
      const target = liveActor(actor);
      return target ? services.isActorCollisionEnabled?.(target) ?? true : false;
    },
  };
}
