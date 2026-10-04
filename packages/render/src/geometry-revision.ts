import { VertexBuffer, type Geometry } from "@babylonjs/core";

type GeometryWatch = {
  users: number;
  /** Every update notification. */
  revision: number;
  /** Position and whole-geometry updates only. */
  positions: number;
  previous: Geometry["onGeometryUpdated"];
  notify: Geometry["onGeometryUpdated"];
};

const watches = new WeakMap<Geometry, GeometryWatch>();

/**
 * Count a geometry's update notifications, e.g. a cable rewriting its vertices in place. Consumers share one
 * `onGeometryUpdated` hook, so a second watcher never looks like a foreign replacement of the first, and the last
 * `unwatchGeometry` restores the previous hook. Pair every call with `unwatchGeometry`.
 */
export function watchGeometry(geometry: Geometry): void {
  const existing = watches.get(geometry);
  if (existing) {
    existing.users++;
    return;
  }
  const previous = geometry.onGeometryUpdated;
  const record: GeometryWatch = {
    users: 1,
    revision: 0,
    positions: 0,
    previous,
    notify: (changed, kind) => {
      previous?.call(geometry, changed, kind);
      record.revision++;
      if (kind === undefined || kind === VertexBuffer.PositionKind) record.positions++;
    },
  };
  geometry.onGeometryUpdated = record.notify;
  watches.set(geometry, record);
}

export function unwatchGeometry(geometry: Geometry): void {
  const record = watches.get(geometry);
  if (!record || --record.users > 0) return;
  if (geometry.onGeometryUpdated === record.notify) geometry.onGeometryUpdated = record.previous;
  watches.delete(geometry);
}

/**
 * Update counts of a watched geometry whose shared hook is still installed; null when unwatched or when
 * another owner replaced the hook, so updates can no longer be counted.
 */
export function geometryRevision(geometry: Geometry): { readonly revision: number; readonly positions: number } | null {
  const record = watches.get(geometry);
  return record && geometry.onGeometryUpdated === record.notify ? record : null;
}
