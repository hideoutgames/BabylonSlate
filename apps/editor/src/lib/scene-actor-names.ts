import type { SerializedScene } from "@haptic/core";

/**
 * Keep saved names intact while telling apart actors that share one. Place and
 * Duplicate mint unique names, but a rename in the Outliner or Details may repeat one.
 */
export function sceneActorDisplayNames(scene: SerializedScene): Map<string, string> {
  const counts = new Map<string, number>();
  for (const actor of scene.actors) {
    counts.set(actor.name, (counts.get(actor.name) ?? 0) + 1);
  }
  return new Map(scene.actors.map((actor) => [actor.id,
    counts.get(actor.name)! > 1 ? `${actor.name} (${actor.id})` : actor.name,
  ]));
}

/**
 * `sceneActorDisplayNames` for a component (`useState(createActorDisplayNamesSelector)`): the map
 * it returned last while the Scene's actors keep the same ids and names in the same order, which
 * is all the names read, so an edit that only moves or changes components keeps it. No Scene: an
 * empty map.
 */
export function createActorDisplayNamesSelector(): (scene: SerializedScene | null) => Map<string, string> {
  let last: { actors: SerializedScene["actors"]; names: Map<string, string> } | null = null;
  return (scene) => {
    const actors = scene?.actors ?? [];
    if (last && (last.actors === actors || (last.actors.length === actors.length &&
      actors.every((actor, index) => actor.id === last!.actors[index]!.id && actor.name === last!.actors[index]!.name)))) {
      if (last.actors !== actors) last = { actors, names: last.names };
      return last.names;
    }
    last = { actors, names: scene ? sceneActorDisplayNames(scene) : new Map<string, string>() };
    return last.names;
  };
}

export function uniqueSceneActorName(scene: SerializedScene, preferred: string): string {
  const names = new Set(scene.actors.map((actor) => actor.name));
  let name = preferred;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${preferred} ${suffix}`;
  return name;
}

/**
 * The name a duplicate starts from: "Box" → "Box Copy", while duplicating
 * "Box Copy" or "Box Copy 3" stays "Box Copy" (the caller numbers it) instead
 * of growing "Box Copy Copy".
 */
export function duplicateBaseName(name: string): string {
  const base = name.replace(/ Copy(?: \d+)?$/, "");
  return `${base} Copy`;
}
