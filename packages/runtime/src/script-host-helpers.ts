import { isSceneLayerAnchorActor, SaveGameError, type SaveGameService } from "@haptic/core";
import { Actor, ActorComponent, Scene, SceneLayer, type EngineObject } from "@haptic/object-model";
import type { Vec3 } from "@haptic/physics";
import { actorLabel } from "./actor-world-transform";
import type { ScriptHostServices } from "./script-host-services";

/** The installed save service, read on each call because `setSaveGameService` installs it after construction. */
export function requireSaveGameService(services: ScriptHostServices): SaveGameService {
  if (!services.saveGame) throw new SaveGameError("unavailable", "Select a default Save Game in Project Settings before using save data.");
  return services.saveGame;
}

export function* componentsOfType(
  services: ScriptHostServices,
  classId: string,
): Generator<ActorComponent, undefined, unknown> {
  const target = String(classId ?? "");
  if (!target) return;
  for (const actor of services.getActors?.() ?? []) {
    if (actor.destroyed) continue;
    for (const component of actor.components) {
      if (component.destroyed) continue;
      if (component.classId === target ||
        (services.classRegistry?.isA(component.classId, target) ?? false)) {
        yield component;
      }
    }
  }
}

export function asActor(target: unknown): Actor | null {
  return target instanceof Actor ? target : null;
}

/** A live actor whose transform a script may write; SceneLayer anchors stay fixed. */
export function transformTarget(target: unknown): Actor | null {
  const actor = asActor(target);
  return actor && !actor.destroyed && !isSceneLayerAnchorActor(actor) ? actor : null;
}

type ScriptNumbers<T extends string> = Partial<Record<T, unknown>> | null | undefined;

/** Coerced finite components, a missing one taking its fallback; null when any is not finite. */
function finiteRecord<T extends string>(value: ScriptNumbers<T>, fallbacks: Record<T, number>): Record<T, number> | null {
  if (!value || typeof value !== "object") return null;
  const result = {} as Record<T, number>;
  for (const key of Object.keys(fallbacks) as T[]) {
    const component = Number(value[key] ?? fallbacks[key]);
    if (!Number.isFinite(component)) return null;
    result[key] = component;
  }
  return result;
}

export function finiteVector(value: ScriptNumbers<"x" | "y" | "z">, fallback: number): Vec3 | null {
  return finiteRecord(value, { x: fallback, y: fallback, z: fallback });
}

export function finiteRotator(value: ScriptNumbers<"pitch" | "yaw" | "roll">): { pitch: number; yaw: number; roll: number } | null {
  return finiteRecord(value, { pitch: 0, yaw: 0, roll: 0 });
}

export function finiteQuat(value: ScriptNumbers<"x" | "y" | "z" | "w">): { x: number; y: number; z: number; w: number } | null {
  return finiteRecord(value, { x: 0, y: 0, z: 0, w: 1 });
}

export function asScriptVec3(
  value: unknown,
): { x: number; y: number; z: number } | null {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(record.x);
  const y = Number(record.y);
  const z = Number(record.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

export function asActorComponent(target: unknown): ActorComponent | null {
  return target instanceof ActorComponent ? target : null;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function findComponentByIdFromTarget(
  target: unknown,
  componentId: string,
  actors: readonly Actor[] | undefined,
  currentScene: Scene | null,
): ActorComponent | null {
  if (target instanceof Scene) {
    if (target.destroyed || currentScene !== target) return null;
    if (!actors) return null;
    for (const actor of actors) {
      if (actor.destroyed) continue;
      const found = findComponentById(actor, componentId);
      if (found) return found;
    }
    return null;
  }
  return findComponentById(asActor(target), componentId);
}

export function findComponentById(
  actor: Actor | null,
  componentId: string,
): ActorComponent | null {
  if (!actor || typeof componentId !== "string" || !componentId) return null;
  return (
    actor.components.find(
      (component) =>
        !component.destroyed && componentMatchesId(component, componentId),
    ) ?? null
  );
}

function componentMatchesId(
  component: ActorComponent,
  componentId: string,
): boolean {
  return component.guid === componentId || component.sourceId === componentId;
}

/**
 * Host invokes (Begin Play / Tick / Destroyed) run unbound entries.
 * Component invokes run the entry whose compiled id matches the live guid or
 * the prefab `sourceId` after instance remapping. Leftover unbound Hit/Click
 * does not run for every component.
 */
export function entryMatchesComponentInvoke(
  entryComponentId: string | undefined,
  invokeComponentId: string | undefined,
  self: EngineObject | null,
): boolean {
  const bound =
    typeof entryComponentId === "string" ? entryComponentId.trim() : "";
  const invoked =
    typeof invokeComponentId === "string" ? invokeComponentId.trim() : "";
  if (!invoked) return !bound;
  if (!bound) return false;
  if (bound === invoked) return true;
  if (!(self instanceof Actor)) return false;
  const component = findComponentById(self, invoked);
  return component ? componentMatchesId(component, bound) : false;
}

export function isTextComponent(component: ActorComponent): boolean {
  return (
    component.classId === "Text3DComponent" ||
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  );
}

export function setActorLink(
  actor: unknown,
  key: "parentId" | "ownerId",
  other: unknown,
): void {
  const target = asActor(actor);
  if (!target || target.destroyed) return;
  const linked = asActor(other);
  // A destroyed actor is a stale reference and leaves the link unchanged.
  if (linked?.destroyed) return;
  target.setVariable(key, linked && linked.guid !== target.guid ? linked.guid : null);
}

/**
 * Scripts may not close a parent cycle. Walk the proposed parent's ancestors
 * (a seen-set stops at loops already present) and refuse with a warning when
 * `child` is `parent` itself or one of `parent`'s ancestors, or the chain
 * already loops.
 */
export function refuseParentCycle(
  services: ScriptHostServices,
  child: Actor,
  parent: Actor,
  operation: string,
): boolean {
  const seen = new Set<string>();
  for (let ancestor: Actor | null = parent; ancestor; ancestor = readActorLink(services, ancestor, "parentId")) {
    if (ancestor.guid === child.guid) {
      services.log("warning", "actor", `${operation} refused: parenting ${actorLabel(child)} to ${actorLabel(parent)} would create a parent cycle.`);
      return true;
    }
    if (seen.has(ancestor.guid)) {
      services.log("warning", "actor", `${operation} refused: ${actorLabel(child)} cannot be parented to ${actorLabel(parent)} because that parent chain already contains a cycle.`);
      return true;
    }
    seen.add(ancestor.guid);
  }
  return false;
}

/**
 * Scripted `parentId` writes get Attach Actor's cycle refusal; the actor's own
 * guid is a cycle too and is refused. Other values are stored unchanged.
 */
export function writeParentId(
  services: ScriptHostServices,
  child: Actor,
  value: unknown,
): void {
  const parent = value === child.guid ? child
    : typeof value === "string" ? resolveLiveActor(services, value) : null;
  if (parent && refuseParentCycle(services, child, parent, "Set parentId")) return;
  child.setVariable("parentId", value);
}

export function readActorLink(
  services: ScriptHostServices,
  actor: unknown,
  key: "parentId" | "ownerId",
): Actor | null {
  const target = asActor(actor);
  if (!target || target.destroyed) return null;
  const id = target.getVariable(key);
  return typeof id === "string" ? resolveLiveActor(services, id) : null;
}

export function resolveLiveActor(
  services: ScriptHostServices,
  actorId: string | null | undefined,
): Actor | null {
  if (!actorId) return null;
  const actor = services.findActor?.(actorId);
  if (!actor || actor.destroyed) return null;
  return actor;
}

export function resolveLiveActors(
  services: ScriptHostServices,
  actorIds: readonly string[],
): Actor[] {
  const seen = new Set<string>();
  const actors: Actor[] = [];
  for (const id of actorIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const actor = resolveLiveActor(services, id);
    if (actor) actors.push(actor);
  }
  return actors;
}

export function vec3Arg(value: unknown): Vec3 {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    x: Number(record.x ?? 0) || 0,
    y: Number(record.y ?? 0) || 0,
    z: Number(record.z ?? 0) || 0,
  };
}

function actorOf(target: unknown): Actor | null {
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

export function animationGraphComponentOf(target: unknown): ActorComponent | null {
  if (
    target instanceof ActorComponent &&
    target.classId === "AnimationGraphComponent" &&
    !target.destroyed
  ) {
    return target;
  }
  return null;
}

const CAMERA_CLASS_IDS: ReadonlySet<string> = new Set(["CameraComponent"]);
const LIGHT_CLASS_IDS: ReadonlySet<string> = new Set(["LightComponent", "AreaRectLightComponent", "HemisphericFillLightComponent"]);

/** The target itself when it is a live component of these classes, else its actor's first live one. */
function liveComponentOf(target: unknown, classIds: ReadonlySet<string>): ActorComponent | null {
  if (target instanceof ActorComponent && classIds.has(target.classId)) return target.destroyed ? null : target;
  return actorOf(target)?.components.find((component) => classIds.has(component.classId) && !component.destroyed) ?? null;
}

export function cameraComponentOf(target: unknown): ActorComponent | null {
  return liveComponentOf(target, CAMERA_CLASS_IDS);
}

export function lightComponentOf(target: unknown): ActorComponent | null {
  return liveComponentOf(target, LIGHT_CLASS_IDS);
}

/** A layer guid string, or a live SceneLayer's guid. */
export function sceneLayerGuidOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return value instanceof SceneLayer && !value.destroyed ? value.guid : null;
}
