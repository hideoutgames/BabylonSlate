import type { SerializedScene } from "@babylonslate/core";

/** Keep saved names intact while making legacy duplicates selectable. */
export function sceneActorDisplayNames(scene: SerializedScene): Map<string, string> {
  const counts = new Map<string, number>();
  for (const actor of scene.actors) {
    counts.set(actor.name, (counts.get(actor.name) ?? 0) + 1);
  }
  return new Map(scene.actors.map((actor) => [actor.id,
    counts.get(actor.name)! > 1 ? `${actor.name} (${actor.id})` : actor.name,
  ]));
}

export function uniqueSceneActorName(scene: SerializedScene, preferred: string): string {
  const names = new Set(scene.actors.map((actor) => actor.name));
  let name = preferred;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${preferred} ${suffix}`;
  return name;
}
