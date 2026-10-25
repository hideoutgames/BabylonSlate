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
  }
  return lights;
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
 * Spawn Actor's compiled call (`actor.spawn` emits `ctx.spawnActorAsync(<class>, <transform>)`): the class is a JSON
 * string when the node names it, any other expression when a pin feeds it.
 */
const SPAWN_CALL = /\bctx\.spawnActorAsync\(\s*(?:("(?:[^"\\\n]|\\.)*")\s*[,)])?/g;

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
