import type { ScriptBundleEntry } from "@haptic/bridge";
import type { AuthoredLightProperties } from "./scene-illumination";

/**
 * A light part Play may spawn: a Light or Hemispheric Fill Light component of a Class's prefab template, with the
 * kind its `light:{kind}` part names (`createPlayLight`) and the properties that part carries.
 */
export type SpawnableLight = { kind: string; properties: AuthoredLightProperties };

/**
 * The light parts the Classes in `scripts` give each actor they spawn (their prefab templates, `components`), keyed by
 * Class and component, as Play's game runtime names them: a Hemispheric Fill Light is `hemispheric`, a Light its Light
 * Kind (`point` when unset). Play's load rehearses one spawned light of each kind among them. Babylon-free, for the
 * hosts' source preparation (`@haptic/render/spawnable-lights`).
 *
 * Lights a script adds with Add Component join them (`addedLights`): an added component takes its class's defaults (a
 * script that then sets its Cast Shadows makes a kind the rehearsal does not stand in for).
 */
export function spawnableLightsFromScripts(scripts: Iterable<ScriptBundleEntry>): Map<string, SpawnableLight> {
  const lights = new Map<string, SpawnableLight>();
  for (const script of scripts) {
    for (const component of script.components ?? []) {
      const properties = component.properties as AuthoredLightProperties & { lightKind?: unknown };
      const kind = component.classId === "HemisphericFillLightComponent" ? "hemispheric"
        : component.classId === "LightComponent" ? (typeof properties.lightKind === "string" ? properties.lightKind : "point")
          : undefined;
      if (kind) lights.set(`${script.classId}|${component.id}`, { kind, properties });
    }
    for (const [key, light] of addedLights(script)) lights.set(key, light);
  }
  return lights;
}

/** The light an Add Component of each light class adds: its defaults (a Light is an unshadowed point). */
const ADDED_LIGHTS: ReadonlyMap<string, SpawnableLight> = new Map([
  ["LightComponent", { kind: "point", properties: {} }],
  ["HemisphericFillLightComponent", { kind: "hemispheric", properties: {} }],
]);

/** Add Component's compiled call (`component.add` emits `ctx.addComponent(<actor>, <class>, <transform>)`). */
const ADD_COMPONENT_CALL = /\bctx\.addComponent\(/g;

/**
 * The lights `script`'s Add Component calls may add: a named light class's, or, for a class a pin or variable feeds,
 * every light class's (it may be any of them).
 */
function addedLights(script: ScriptBundleEntry): Map<string, SpawnableLight> {
  const lights = new Map<string, SpawnableLight>();
  for (const call of script.source.matchAll(ADD_COMPONENT_CALL)) {
    const classArgument = callArguments(script.source, call.index + call[0].length)[1]?.trim();
    let classId: unknown;
    try {
      classId = classArgument?.startsWith('"') ? JSON.parse(classArgument) : undefined;
    } catch {
      classId = undefined;
    }
    if (typeof classId === "string") {
      const light = ADDED_LIGHTS.get(classId);
      if (light) lights.set(`${script.classId}|added ${classId}`, light);
      continue;
    }
    for (const [added, light] of ADDED_LIGHTS) lights.set(`${script.classId}|added ${added}`, light);
  }
  return lights;
}

/** The top-level argument texts of the call whose argument list starts at `start` (just after its opening bracket). */
function callArguments(source: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = start;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (char === '"' || char === "'" || char === "`") {
      // Skip a string literal, escapes included.
      for (index++; index < source.length && source[index] !== char; index++) if (source[index] === "\\") index++;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        args.push(source.slice(from, index));
        return args;
      }
      depth--;
    } else if (char === "," && depth === 0) {
      args.push(source.slice(from, index));
      from = index + 1;
    }
  }
  return args;
}

/**
 * What a Class the load cannot see may spawn, rehearsed in its place: a point and a spot light, each with and without
 * shadows (a Spawn Actor's Class is taken never to carry a directional or hemispheric light).
 */
export const UNSEEN_CLASS_LIGHTS: ReadonlyMap<string, SpawnableLight> = new Map([
  ["unseen Class|point", { kind: "point", properties: {} }],
  ["unseen Class|point with shadows", { kind: "point", properties: { castShadows: true } }],
  ["unseen Class|spot", { kind: "spot", properties: {} }],
  ["unseen Class|spot with shadows", { kind: "spot", properties: { castShadows: true } }],
]);

/**
 * Spawn Actor's and Deferred Spawn Actor's compiled calls (`actor.spawn` emits `ctx.spawnActorAsync(<class>,
 * <transform>)`, `actor.deferredSpawn` `ctx.beginDeferredSpawnActorAsync(…)`): the class is a JSON string when the
 * node names it, any other expression when a pin feeds it.
 */
const SPAWN_CALL = /\bctx\.(?:spawnActorAsync|beginDeferredSpawnActorAsync)\(\s*(?:("(?:[^"\\\n]|\\.)*")\s*[,)])?/g;

/** One load's sources: its compiled Classes and every asset it holds, with that asset's dependencies, soft ones included. */
export type SpawnableLightLoad = {
  scripts: readonly ScriptBundleEntry[];
  assets: Iterable<{ guid: string; dependencies?: readonly string[] }>;
  /** Whether `guid` names a Class asset. */
  isClass(guid: string): boolean;
};

/**
 * Whether the load may spawn a Class whose lights it cannot see, because none of its scripts is that Class's: an
 * asset it holds depends on a Class asset none of its scripts belongs to (a Load On Demand reference: a Spawn Actor's
 * named Class, a Class variable's or a data asset's value), or a script spawns a Class it does not name or names one
 * none of its scripts is (an engine base Class included). Errs toward yes: a reference may never be spawned.
 */
export function spawnsUnseenClasses(load: SpawnableLightLoad): boolean {
  const held = new Set(load.scripts.map((script) => script.assetGuid));
  const classIds = new Set(load.scripts.map((script) => script.classId));
  for (const asset of load.assets)
    for (const dependency of asset.dependencies ?? []) if (!held.has(dependency) && load.isClass(dependency)) return true;
  for (const script of load.scripts) {
    for (const call of script.source.matchAll(SPAWN_CALL)) {
      let classId: unknown;
      try {
        classId = call[1] === undefined ? undefined : JSON.parse(call[1]);
      } catch {
        return true;
      }
      if (typeof classId !== "string" || !classIds.has(classId)) return true;
    }
  }
  return false;
}

/**
 * The light parts a load's Classes may spawn (`spawnableLightsFromScripts`), and when it may spawn a Class it cannot
 * see (`spawnsUnseenClasses`), the generic kinds that stand for that Class's (`UNSEEN_CLASS_LIGHTS`). Editor Play and
 * the player call it with each source preparation.
 */
export function spawnableLightsOfLoad(load: SpawnableLightLoad): Map<string, SpawnableLight> {
  const lights = spawnableLightsFromScripts(load.scripts);
  if (spawnsUnseenClasses(load)) for (const [key, light] of UNSEEN_CLASS_LIGHTS) lights.set(key, light);
  return lights;
}

