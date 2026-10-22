import type { Actor, World } from "@haptic/object-model";

const NO_ACTORS: readonly Actor[] = [];
const indexes = new WeakMap<World, { revision: number; byLayer: ReadonlyMap<string, readonly Actor[]> }>();

/**
 * The actors of one Scene Layer instance, in `world.getActors()` order. An actor's layer is fixed when it is
 * created and a spawn or destroy bumps `structuralRevision`, so one pass over the World serves every layer until
 * the next structural change; a layer then walks only its own actors instead of the whole World. A list is never
 * mutated once built, so a walk over it is unaffected by later spawns or destroys. Code that reassigns an
 * existing actor's `sceneLayerId` must call `world.markStructureChanged()`.
 */
export function sceneLayerActors(world: World, layerId: string): readonly Actor[] {
  const revision = world.structuralRevision;
  let entry = indexes.get(world);
  if (entry?.revision !== revision) {
    const byLayer = new Map<string, Actor[]>();
    for (const actor of world.getActors()) {
      if (actor.sceneLayerId == null) continue;
      const group = byLayer.get(actor.sceneLayerId);
      if (group) group.push(actor);
      else byLayer.set(actor.sceneLayerId, [actor]);
    }
    entry = { revision, byLayer };
    indexes.set(world, entry);
  }
  return entry.byLayer.get(layerId) ?? NO_ACTORS;
}
