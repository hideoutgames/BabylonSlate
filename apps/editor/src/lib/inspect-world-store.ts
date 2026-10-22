import type { DebugInspectSnapshot } from "@haptic/object-model";

/** The named actors a console completes: only these fields of a snapshot feed it. */
export type InspectActorRef = { kind: string; label: string; id: string };

/**
 * The latest Play inspect snapshot, outside React state: polling it does not
 * re-render its owner, and a consumer re-renders only for snapshots whose
 * content differs from the one it already shows.
 */
export interface InspectWorldStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DebugInspectSnapshot;
  /**
   * Actor id/label pairs of the current snapshot. The same array while no
   * actor appears, disappears or is renamed, so console completion ignores
   * tick-to-tick variable changes.
   */
  getActors: () => readonly InspectActorRef[];
  /** Replace the snapshot unless `next` has identical content. */
  publish: (next: DebugInspectSnapshot) => void;
}

const EMPTY_SNAPSHOT: DebugInspectSnapshot = { tickIndex: 0, nodes: [] };

function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Structural equality for JSON-like values. Anything it cannot compare by
 * structure (a Map, a class instance) counts as different unless identical,
 * so a skipped publish never hides a change.
 */
export function sameInspectValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!sameInspectValue(a[index], b[index])) return false;
    }
    return true;
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameInspectValue(left[key], right[key])) return false;
  }
  return true;
}

export function createInspectWorldStore(
  initial: DebugInspectSnapshot = EMPTY_SNAPSHOT,
): InspectWorldStore {
  const listeners = new Set<() => void>();
  let snapshot = initial;
  let actors: readonly InspectActorRef[] = [];
  let actorsOf: DebugInspectSnapshot | null = null;

  const actorsFor = (): readonly InspectActorRef[] => {
    if (actorsOf === snapshot) return actors;
    const next: InspectActorRef[] = [];
    for (const node of snapshot.nodes) {
      if (node.kind === "actor") next.push({ kind: node.kind, label: node.label, id: node.id });
    }
    actorsOf = snapshot;
    if (!sameInspectValue(actors, next)) actors = next;
    return actors;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getActors: actorsFor,
    publish: (next) => {
      if (sameInspectValue(snapshot, next)) return;
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
