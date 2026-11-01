import { embeddedScriptParentOf, isLockedEngineClassId, SUBSYSTEM_CLASS_ID } from "./ids";

/**
 * The engine Script Interface that gives a Create Object class Event Tick.
 * It has no functions; classes list it like any interface asset guid.
 */
export const TICKABLE_OBJECT_INTERFACE_GUID = "engine:TickableObject";
export const TICKABLE_OBJECT_INTERFACE_NAME = "Tickable Object";

/**
 * Whether Create Object accepts a class, from its ancestry (class first):
 * its nearest engine base is Object itself, so Actors, components, the Game
 * Instance, subsystems, libraries, commands, editor utilities, behaviour
 * tree nodes and Scene scripts are refused.
 */
export function isCreatableObjectChain(chain: readonly string[]): boolean {
  for (const classId of chain) {
    if (classId === "Object") return true;
    if (isLockedEngineClassId(classId) || embeddedScriptParentOf(classId)) return false;
  }
  return false;
}

/**
 * Whether a class already receives Event Tick from the engine: Actors,
 * components, the Game Instance, subsystems, and Scene and Scene Layer
 * scripts. Tickable Object on such a class is a compile error.
 */
export function receivesEngineTick(chain: readonly string[]): boolean {
  return chain.some((classId) =>
    classId === "Actor" || classId === "ActorComponent" || classId === "GameInstance" ||
    classId === SUBSYSTEM_CLASS_ID || classId === "Scene" || classId === "SceneLayer" ||
    embeddedScriptParentOf(classId) !== undefined);
}
