import {
  cloneTweenValue, identityTransform, isSceneLayerAnchorActor, normalizeQuat, rotatorToQuat,
  springArmChildOffset, type Transform, type TweenTransformSpace,
} from "@babylonslate/core";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import {
  actorChainWorldTransform, actorParentGuid, composeParentChildTransform, copyTransform,
  inverseQuaternion, multiplyQuaternion, rotateVector,
} from "./actor-world-transform";

export type TweenTransformTarget = Actor | ActorComponent;
export type TweenTransformChannel = "position" | "rotation" | "scale" | "transform";

type ActorLookup = (guid: string) => Actor | undefined;

function parentFrame(target: TweenTransformTarget, findActor: ActorLookup): Transform | null {
  if (target instanceof Actor) {
    // Validate the entire chain, including cycles that return to the target.
    if (!actorChainWorldTransform(target, findActor)) return null;
    const parentId = actorParentGuid(target);
    const parent = parentId ? findActor(parentId) : undefined;
    return parent ? actorChainWorldTransform(parent, findActor) : identityTransform();
  }
  const owner = target.owner!;
  let frame = actorChainWorldTransform(owner, findActor);
  if (!frame) return null;
  const chain: ActorComponent[] = [];
  const visited = new Set([target.guid]);
  let parentId = target.parentId;
  while (parentId) {
    const parent = owner.components.find(component => component.guid === parentId || component.sourceId === parentId);
    if (!parent) break;
    if (parent.destroyed || visited.has(parent.guid)) return null;
    visited.add(parent.guid);
    chain.push(parent);
    parentId = parent.parentId;
  }
  for (let index = chain.length - 1; index >= 0; index--) {
    const parent = chain[index]!;
    frame = composeParentChildTransform(frame, parent.transform);
    const socket = springArmChildOffset({ classId: parent.classId, properties: { armLength: parent.getVariable("armLength") } });
    if (socket) frame = composeParentChildTransform(frame, {
      ...identityTransform(), position: { x: socket[0], y: socket[1], z: socket[2] },
    });
  }
  return frame;
}

/**
 * Apply one authored tween sample. World values are converted through the live
 * parent pose on every call. The caller owns physics and component publication.
 * Returns false without writing when the target or inverse pose is invalid.
 */
export function applyTweenTransform(
  target: TweenTransformTarget,
  channel: TweenTransformChannel,
  value: unknown,
  space: TweenTransformSpace,
  findActor: ActorLookup,
): boolean {
  const owner = target instanceof Actor ? target : target.owner;
  if (!owner || owner.destroyed || target.destroyed || findActor(owner.guid) !== owner) return false;
  if (target instanceof Actor ? isSceneLayerAnchorActor(target) : !owner.components.includes(target)) return false;
  let sample: Partial<Transform>;
  if (channel === "transform") {
    const transform = cloneTweenValue("transform", value);
    if (!transform) return false;
    sample = transform;
  } else if (channel === "rotation") {
    const rotation = cloneTweenValue("rotator", value);
    if (!rotation) return false;
    sample = { rotation: rotatorToQuat(rotation) };
  } else {
    const vector = cloneTweenValue("vec3", value);
    if (!vector) return false;
    sample = { [channel]: vector };
  }
  const next = copyTransform(target.transform);
  if (space === "world") {
    const rawParent = parentFrame(target, findActor);
    const parent = rawParent && cloneTweenValue("transform", rawParent);
    if (!parent) return false;
    // Inverting position or scale through a collapsed parent has no unique result.
    if ((sample.position || sample.scale) && [parent.scale.x, parent.scale.y, parent.scale.z].some(axis => axis === 0)) return false;
    const inverseRotation = inverseQuaternion(parent.rotation);
    if (sample.position) {
      const relative = rotateVector(inverseRotation, {
        x: sample.position.x - parent.position.x,
        y: sample.position.y - parent.position.y,
        z: sample.position.z - parent.position.z,
      });
      next.position = { x: relative.x / parent.scale.x, y: relative.y / parent.scale.y, z: relative.z / parent.scale.z };
    }
    if (sample.rotation) next.rotation = normalizeQuat(multiplyQuaternion(inverseRotation, sample.rotation));
    if (sample.scale) next.scale = {
      x: sample.scale.x / parent.scale.x,
      y: sample.scale.y / parent.scale.y,
      z: sample.scale.z / parent.scale.z,
    };
  } else {
    if (sample.position) next.position = sample.position;
    if (sample.rotation) next.rotation = sample.rotation;
    if (sample.scale) next.scale = sample.scale;
  }
  if (!cloneTweenValue("transform", next)) return false;
  // Preserve transform and untouched-channel identity for existing readers.
  if (sample.position) Object.assign(target.transform.position, next.position);
  if (sample.rotation) Object.assign(target.transform.rotation, next.rotation);
  if (sample.scale) Object.assign(target.transform.scale, next.scale);
  return true;
}
