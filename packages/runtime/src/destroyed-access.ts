import { EngineObject, isSceneAssetClassId, isSceneLayerAssetClassId } from "@haptic/object-model";
import type { ScriptHostServices } from "./script-host-services";

/** The diagnostic code of a script reading, writing or calling a destroyed object. */
export const DESTROYED_ACCESS_DIAGNOSTIC_CODE = "runtime.destroyedAccess";

/** What a script did to a destroyed object: read or wrote a variable, or called a member. */
export type DestroyedAccessKind = "access" | "set" | "call";

/**
 * Where a compiled node touched its subject, and how: a frozen module-scope constant the node passes only when
 * the subject is destroyed.
 */
export interface ScriptAccessLocation {
  readonly assetGuid: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly kind: DestroyedAccessKind;
  readonly member: string;
}

/** One destroyed access for the host to report; without `location` the host finds the node on the stack. */
export interface DestroyedAccess {
  kind: DestroyedAccessKind;
  member: string;
  /** The destroyed object's class as messages name it. */
  className: string;
  location?: { assetGuid: string; graphId: string; nodeId: string };
}

/** A destroyed object's class as a message names it: a Scene or Scene Layer by its kind, any other by its class. */
export function destroyedClassName(object: EngineObject): string {
  if (isSceneAssetClassId(object.classId)) return "Scene";
  if (isSceneLayerAssetClassId(object.classId)) return "Scene Layer";
  return object.classId;
}

export function destroyedAccessMessage({ kind, member, className }: Pick<DestroyedAccess, "kind" | "member" | "className">): string {
  if (kind === "access") return `Tried to access "${member}" from null of type "${className}"`;
  if (kind === "set") return `Tried to set "${member}" on null of type "${className}"`;
  return `Tried to call "${member}" on null of type "${className}"`;
}

/** Whether `target` is an engine object whose destruction finished: the one test a valid access pays. */
export function isReleasedObject(target: unknown): boolean {
  return target instanceof EngineObject && target.stateReleased;
}

/** Hands a destroyed access to the host, which reports it once; a host without a reporter logs it. */
export function reportDestroyedAccess(services: Pick<ScriptHostServices, "log" | "reportDestroyedAccess">, access: DestroyedAccess): void {
  if (services.reportDestroyedAccess) services.reportDestroyedAccess(access);
  else services.log("error", "Script", destroyedAccessMessage(access));
}

/**
 * A script call on `target` that `isReleasedObject` holds for: reported with no location, which the host finds on
 * the stack. The caller then returns its empty result.
 */
export function reportDestroyedTarget(
  services: Pick<ScriptHostServices, "log" | "reportDestroyedAccess">,
  kind: DestroyedAccessKind,
  member: unknown,
  target: unknown,
): void {
  if (!(target instanceof EngineObject)) return;
  reportDestroyedAccess(services, { kind, member: String(member ?? ""), className: destroyedClassName(target) });
}
