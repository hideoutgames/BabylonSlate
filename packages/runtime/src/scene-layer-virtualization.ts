import { isVirtualizedOverlayClass, overlayLayoutKey, parseOverlayContainerProperties, type OverlayLayoutEntry } from "@haptic/core";
import type { Actor } from "@haptic/object-model";

type Pool = { layerId: string; owner: Actor; classId: string; actors: Map<number, Actor> };
/** Only visible indices (plus overscan) own Actors, components and render resources. */
export class SceneLayerVirtualization {
  private readonly pools = new Map<string, Pool>();

  /** `byId` is a guid index of `actors` as of this call; a caller that already has one passes it. */
  sync(layerId: string, actors: readonly Actor[], entries: ReadonlyMap<string, OverlayLayoutEntry>,
    spawn: (parent: Actor, classId: string, defaults: Record<string, unknown>) => Actor | null,
    remove: (actor: Actor) => void,
    byId: ReadonlyMap<string, Actor> = new Map(actors.map(actor => [actor.guid, actor]))): boolean {
    let changed = false;
    const live = new Set<string>();
    const ancestry = (actor: Actor): { depth: number; classes: Set<string> } => {
      let parent: Actor | undefined = actor, depth = 0;
      const seen = new Set<string>(), classes = new Set<string>();
      while (parent && !seen.has(parent.guid)) {
        seen.add(parent.guid); classes.add(parent.classId);
        if (typeof parent.getVariable("virtualizedContainerId") === "string") depth++;
        const parentId = parent.getVariable("parentId");
        parent = typeof parentId === "string" ? byId.get(parentId) : undefined;
      }
      return { depth, classes };
    };
    let liveCount = [...this.pools.values()].filter(pool => pool.layerId === layerId).reduce((count, pool) => count + [...pool.actors.values()].filter(actor => !actor.destroyed).length, 0);
    for (const owner of actors) {
      if (owner.destroyed || owner.sceneLayerId !== layerId) continue;
      // Most actors own no virtualized container; walk the ancestors only for those that do.
      let ancestors: ReturnType<typeof ancestry> | undefined;
      for (const component of owner.components) {
        if (component.destroyed || !isVirtualizedOverlayClass(component.classId)) continue;
        ancestors ??= ancestry(owner);
        if (ancestors.depth >= 16) break;
        const key = overlayLayoutKey(owner.guid, component.guid), entry = entries.get(key);
        const p = parseOverlayContainerProperties(Object.fromEntries(component.variables));
        if (!entry?.virtual || !p.itemClassId || entry.interactive === false || ancestors.classes.has(p.itemClassId)) continue;
        live.add(key);
        let pool = this.pools.get(key);
        if (pool && (pool.classId !== p.itemClassId || pool.owner !== owner)) {
          for (const actor of pool.actors.values()) if (!actor.destroyed) { remove(actor); liveCount--; }
          this.pools.delete(key); pool = undefined; changed = true;
        }
        if (!pool) {
          pool = { layerId, owner, classId: p.itemClassId, actors: new Map() };
          this.pools.set(key, pool);
        }
        for (const [index, actor] of pool.actors) {
          if (index >= entry.virtual.first && index < entry.virtual.end && !actor.destroyed) continue;
          if (!actor.destroyed) { remove(actor); liveCount--; }
          pool.actors.delete(index); changed = true;
        }
        for (let index = entry.virtual.first; index < entry.virtual.end; index++) {
          if (pool.actors.has(index)) continue;
          if (liveCount >= 8192) break;
          const actor = spawn(owner, p.itemClassId, { itemIndex: index, virtualizedContainerId: component.guid });
          if (actor && !actor.destroyed) { pool.actors.set(index, actor); liveCount++; changed = true; }
        }
      }
    }
    for (const [key, pool] of this.pools) {
      if (pool.layerId !== layerId || live.has(key)) continue;
      for (const actor of pool.actors.values()) if (!actor.destroyed) { remove(actor); liveCount--; }
      this.pools.delete(key); changed = true;
    }
    return changed;
  }

  remove(layerId: string): void {
    for (const [key, pool] of this.pools) if (pool.layerId === layerId) this.pools.delete(key);
  }
  clear(): void { this.pools.clear(); }
}
