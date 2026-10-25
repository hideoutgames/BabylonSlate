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
