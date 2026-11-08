import { ACTOR_TAGS_PROPERTY, normalizeQuat, normalizeTagContainer, rotatorToQuat, type TagContainer, type Transform } from "@haptic/core";
import { Actor, ActorComponent, EngineObject } from "@haptic/object-model";
import {
  actorChainWorldTransform, actorParentGuid, copyTransform, inverseQuaternion, multiplyQuaternion, rotateVector,
} from "./actor-world-transform";
import type { HostContextMembers } from "./script-context-types";
import { asActor, asActorComponent, finiteRotator, finiteVector, transformTarget } from "./script-host-helpers";
import type { ScriptHostServices } from "./script-host-services";
import { propertyTweenReference } from "./tween-targets";
import { componentWorldTransform } from "./tween-transforms";

type ObjectMemberKey =
  | "setActorHidden" | "isActorHidden" | "setComponentVisible" | "isComponentVisible"
  | "componentTransform" | "setComponentTransform" | "actorDistance" | "addActorLocalOffset"
  | "addActorLocalRotation" | "addActorWorldRotation" | "teleportActor" | "getActorTags" | "setActorTags"
  | "getObjectClass" | "classIsChildOf" | "getDisplayName";

const TRANSFORM_VALUE_TYPES = { position: "vec3", rotation: "rotator", scale: "vec3", transform: "transform" } as const;

/** A live component that has a place in its actor (not a 2D anchor or a Movement Component). */
function spatialComponent(target: unknown): ActorComponent | null {
  const component = asActorComponent(target);
  return component && !component.destroyed && component.owner && !component.owner.destroyed ? component : null;
}

/** The component and every component attached below it on the same actor. */
function withDescendants(component: ActorComponent): ActorComponent[] {
  const owner = component.owner;
  if (!owner) return [component];
  const result = [component];
  const ids = new Set([component.guid, component.sourceId].filter((id): id is string => Boolean(id)));
  for (let grew = true; grew;) {
    grew = false;
    for (const candidate of owner.components) {
      if (result.includes(candidate) || candidate.destroyed || !candidate.parentId || !ids.has(candidate.parentId)) continue;
      result.push(candidate);
      ids.add(candidate.guid);
      if (candidate.sourceId) ids.add(candidate.sourceId);
      grew = true;
    }
  }
  return result;
}

/**
 * Visibility, component transforms, actor offsets and rotations, actor Tags and class reads
 * (`scripting-nodes`: actor, component, transform, tags and object groups).
 */
export function createObjectMembers(services: ScriptHostServices): Pick<HostContextMembers, ObjectMemberKey> {
  const findActor = (guid: string) => services.findActor?.(guid);
  const worldOf = (actor: Actor): Transform | null => actorChainWorldTransform(actor, findActor);
  /** The rotation of the frame an actor's transform is relative to: its parent actor's world rotation. */
  const parentRotation = (actor: Actor) => {
    const parentId = actorParentGuid(actor);
    const parent = parentId ? findActor(parentId) : undefined;
    return parent ? worldOf(parent)?.rotation ?? null : { x: 0, y: 0, z: 0, w: 1 };
  };
  return {
    setActorHidden: (actor, hidden) => {
      const target = asActor(actor);
      if (target && !target.destroyed) target.setVariable("visible", hidden !== true);
    },
    isActorHidden: (actor) => asActor(actor)?.getVariable("visible") === false,
    setComponentVisible: (target, visible, propagate) => {
      const component = spatialComponent(target);
      if (!component) return;
      for (const entry of propagate === true ? withDescendants(component) : [component]) {
        if ((entry.getVariable("visible") !== false) === (visible === true)) continue;
        entry.setVariable("visible", visible === true);
        services.refreshComponent?.(entry, "visible");
      }
    },
    isComponentVisible: (target) => {
      const component = asActorComponent(target);
      return Boolean(component) && component!.getVariable("visible") !== false;
    },
    componentTransform: (target, space) => {
      const component = spatialComponent(target);
      if (!component) return null;
      return space === "world" ? componentWorldTransform(component, findActor) : copyTransform(component.transform);
    },
    setComponentTransform: (target, channel, value, space) => {
      const component = spatialComponent(target);
      const type = TRANSFORM_VALUE_TYPES[channel];
      if (!component || !type) return;
      propertyTweenReference(component, `component.${channel}`, type, space === "world" ? "world" : "local", services)?.set(value);
    },
    actorDistance: (a, b) => {
      const from = asActor(a);
      const to = asActor(b);
      const start = from && !from.destroyed ? worldOf(from)?.position : null;
      const end = to && !to.destroyed ? worldOf(to)?.position : null;
      return start && end ? Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) : 0;
    },
    addActorLocalOffset: (actor, offset) => {
      const target = transformTarget(actor);
      const delta = finiteVector(offset, 0);
      if (!target || !delta) return;
      // Local axes are the actor's own rotation; its scale does not stretch the offset.
      const moved = rotateVector(target.transform.rotation, delta);
      const position = finiteVector({
        x: target.transform.position.x + moved.x,
        y: target.transform.position.y + moved.y,
        z: target.transform.position.z + moved.z,
      }, 0);
      if (!position) return;
      Object.assign(target.transform.position, position);
      services.teleportActor?.(target);
    },
    addActorLocalRotation: (actor, rotation) => {
      const target = transformTarget(actor);
      const rotator = finiteRotator(rotation);
      if (!target || !rotator) return;
      Object.assign(target.transform.rotation, normalizeQuat(multiplyQuaternion(target.transform.rotation, rotatorToQuat(rotator))));
      services.teleportActor?.(target);
    },
    addActorWorldRotation: (actor, rotation) => {
      const target = transformTarget(actor);
      const rotator = finiteRotator(rotation);
      const parent = target ? parentRotation(target) : null;
      if (!target || !rotator || !parent) return;
      // World delta in the parent's frame: parent⁻¹ × delta × parent, applied before the local rotation.
      const delta = multiplyQuaternion(multiplyQuaternion(inverseQuaternion(parent), rotatorToQuat(rotator)), parent);
      Object.assign(target.transform.rotation, normalizeQuat(multiplyQuaternion(delta, target.transform.rotation)));
      services.teleportActor?.(target);
    },
    teleportActor: (actor, location, rotation, resetVelocity) => {
      const target = transformTarget(actor);
      const position = finiteVector(location, 0);
      const rotator = finiteRotator(rotation);
      if (!target || !position || !rotator) return;
      Object.assign(target.transform.position, position);
      Object.assign(target.transform.rotation, rotatorToQuat(rotator));
      services.teleportActor?.(target, { velocity: resetVelocity === true ? "reset" : "preserve" });
    },
    getActorTags: (actor) => normalizeTagContainer(asActor(actor)?.getVariable(ACTOR_TAGS_PROPERTY)),
    setActorTags: (actor, tags) => {
      const target = asActor(actor);
      if (target && !target.destroyed) target.setVariable(ACTOR_TAGS_PROPERTY, normalizeTagContainer(tags) satisfies TagContainer);
    },
    getObjectClass: (object) =>
      object instanceof EngineObject && !object.destroyed && object.classId ? object.classId : null,
    classIsChildOf: (classId, parentClassId) => {
      const id = typeof classId === "string" ? classId.trim() : "";
      const parent = typeof parentClassId === "string" ? parentClassId.trim() : "";
      if (!id || !parent) return false;
      return id === parent || (services.classRegistry?.isA(id, parent) ?? false);
    },
    getDisplayName: (object) => {
      if (!(object instanceof EngineObject) || object.destroyed) return "";
      // An actor or component shows its name; any other object, and an unnamed one, its class.
      const name = object instanceof Actor || object instanceof ActorComponent ? object.getVariable("name") : undefined;
      return typeof name === "string" && name.trim() ? name : object.classId ?? "";
    },
  };
}
