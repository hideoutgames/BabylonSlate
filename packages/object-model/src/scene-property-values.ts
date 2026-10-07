import { Actor, ActorComponent } from "./objects";

/**
 * Resolve the scene-value tags emitted by canonical runtime capture only after
 * every actor/component identity exists and before any creation hook runs.
 */
export function hydrateScenePropertyReferences(actors: readonly Actor[]): void {
  const byId = new Map<string, Actor>();
  for (const actor of actors) {
    if (byId.has(actor.guid)) throw new Error(`Duplicate scene actor identity: ${actor.guid}`);
    byId.set(actor.guid, actor);
  }
  const decode = (value: unknown, depth = 0): unknown => {
    if (depth > 128) throw new Error("Scene property nesting exceeds the supported limit.");
    if (value instanceof Actor || value instanceof ActorComponent || value === null || typeof value !== "object") return value;
    if (value instanceof Map) {
      let changed: Map<unknown, unknown> | undefined;
      for (const [key, entry] of value) {
        const decodedKey = decode(key, depth + 1), decodedEntry = decode(entry, depth + 1);
        if (decodedKey !== key || decodedEntry !== entry) {
          changed ??= new Map(value);
          if (decodedKey !== key && changed.has(decodedKey)) throw new Error("Duplicate persisted scene map key.");
          changed.delete(key); changed.set(decodedKey, decodedEntry);
        }
      }
      return changed ?? value;
    }
    if (Array.isArray(value)) {
      let changed: unknown[] | undefined;
      for (let index = 0; index < value.length; index++) {
        const decoded = decode(value[index], depth + 1);
        if (decoded !== value[index]) { changed ??= [...value]; changed[index] = decoded; }
      }
      return changed ?? value;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const row = value as Record<string, unknown>;
    if (Object.hasOwn(row, "$sceneValue")) {
      if (row.$sceneValue === "undefined" && Object.keys(row).length === 1) return undefined;
      if (row.$sceneValue === "reference" && typeof row.actorId === "string" && Object.keys(row).every(key => ["$sceneValue", "actorId", "componentId"].includes(key))) {
        const actor = byId.get(row.actorId);
        if (!actor) throw new Error(`Scene property references missing actor: ${row.actorId}`);
        if (row.componentId === undefined) return actor;
        const component = actor.components.find((entry) => entry.guid === row.componentId && !entry.destroyed);
        if (!component) throw new Error(`Scene property references missing component: ${String(row.componentId)}`);
        return component;
      }
      if (row.$sceneValue === "map" && Array.isArray(row.entries) && Object.keys(row).length === 2) {
        const result = new Map<unknown, unknown>();
        for (const entry of row.entries) {
          if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid persisted scene map entry.");
          const key = decode(entry[0], depth + 1);
          if (result.has(key)) throw new Error("Duplicate persisted scene map key.");
          result.set(key, decode(entry[1], depth + 1));
        }
        return result;
      }
      throw new Error("Invalid persisted scene value tag.");
    }
    let changed: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(row)) {
      const decoded = decode(entry, depth + 1);
      if (decoded !== entry) {
        changed ??= { ...row };
        Object.defineProperty(changed, key, { value: decoded, enumerable: true, configurable: true, writable: true });
      }
    }
    return changed ?? row;
  };
  // Stage all values before changing any object; malformed references fail atomically.
  const staged: Array<[Actor | ActorComponent, string, unknown]> = [];
  for (const actor of actors) for (const object of [actor, ...actor.components]) {
    for (const [name, value] of object.variables) {
      const decoded = decode(value);
      if (decoded !== value) staged.push([object, name, decoded]);
    }
  }
  for (const [object, name, value] of staged) object.setVariable(name, value);
}
