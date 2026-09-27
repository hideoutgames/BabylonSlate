import {
  createDefaultRenderTargetCaptureProperties,
  normalizeRenderTargetCaptureProperties,
  springArmChildOffset,
  type RenderTargetCaptureProperties,
  type RenderTargetCaptureProperty,
  type Transform,
} from "@babylonslate/core";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { composeParentChildTransform } from "./actor-world-transform";

const keys = Object.keys(createDefaultRenderTargetCaptureProperties()) as RenderTargetCaptureProperty[];

export function captureComponent(target: unknown): ActorComponent | null {
  if (!(target instanceof Actor) || target.destroyed || target.sceneLayerId) return null;
  return target.components.find((component) =>
    component.classId === "RenderTargetCaptureComponent" && !component.destroyed,
  ) ?? null;
}

export function captureProperties(component: ActorComponent): RenderTargetCaptureProperties {
  return normalizeRenderTargetCaptureProperties(Object.fromEntries(
    keys.map((key) => [key, component.getVariable(key)]),
  ));
}

export function captureActorReferences(component: ActorComponent, findActor: (id: string) => Actor | undefined): Actor[] {
  return captureProperties(component).actorIds.flatMap((id) => {
    const actor = findActor(id);
    return actor && !actor.destroyed && !actor.sceneLayerId ? [actor] : [];
  });
}

/** Store serializable ids internally; graph pins always exchange live Actor instances. */
export function setCaptureProperty(
  component: ActorComponent,
  key: RenderTargetCaptureProperty,
  value: unknown,
  findActor: (id: string) => Actor | undefined,
): boolean {
  if (!keys.includes(key)) return false;
  if (key === "actorIds") {
    if (!Array.isArray(value) || value.some((actor) =>
      !(actor instanceof Actor) || actor.destroyed || actor.sceneLayerId || findActor(actor.guid) !== actor,
    )) return false;
    value = value.map((actor: Actor) => actor.guid);
  } else if (key === "renderTargetGuid") {
    if (value !== null && typeof value !== "string") return false;
  } else if (key === "enabled" || key === "captureEveryFrame" || key === "captureOnlyActors") {
    if (typeof value !== "boolean") return false;
  } else if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const normalized = normalizeRenderTargetCaptureProperties({ ...captureProperties(component), [key]: value });
  // Clip limits are coupled, so write the normalized tuple together.
  for (const name of keys) component.setVariable(name, normalized[name]);
  return true;
}

/** Capture lenses follow the same authored component hierarchy as their editor model. */
export function captureLocalTransform(component: ActorComponent): Transform {
  let result = component.transform;
  const visited = new Set([component.guid]);
  let parentId = component.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = component.owner?.components.find((candidate) => candidate.guid === parentId && !candidate.destroyed);
    if (!parent) break;
    const offset = springArmChildOffset({ classId: parent.classId, properties: { armLength: parent.getVariable("armLength") } });
    if (offset) result = { ...result, position: { x: result.position.x + offset[0], y: result.position.y + offset[1], z: result.position.z + offset[2] } };
    result = composeParentChildTransform(parent.transform, result);
    parentId = parent.parentId;
  }
  return result;
}
