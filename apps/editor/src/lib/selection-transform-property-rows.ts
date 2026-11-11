import type { PropertyRow, Vector3Value } from "@haptic/editor-kit";
import {
  eulerDegreesToQuaternion,
  quaternionToEulerDegrees,
  type SerializedActor,
} from "@haptic/core";
import { depthFromZOrder, zOrderFromDepth, type TransformRowsMode } from "./transform-property-rows";
import { scaleLinkKey, type LinkedScale } from "./linked-scale";

/**
 * Shared axis edits are absolute values; other axes retain each actor's values.
 * Every row carries each actor's own values, so a mixed axis or Z-Order types
 * and scrubs each actor from its own value (`Mixed Values+4`).
 */
export function selectionTransformPropertyRows(
  actors: readonly SerializedActor[],
  mode: TransformRowsMode,
  updateSelected: (update: (actor: SerializedActor) => SerializedActor) => void,
  linkedScale?: LinkedScale,
): PropertyRow[] {
  const primary = actors[0];
  if (!primary) return [];
  const planar = mode !== "3d";
  const twoD = mode === "2d";
  const actorIndex = new Map(actors.map((actor, index) => [actor.id, index]));
  const rows: PropertyRow[] = [];
  for (const property of ["position", "rotation", "scale"] as const) {
    const axes = property === "position"
      ? planar ? [0, 1] : [0, 1, 2]
      : twoD ? (property === "rotation" ? [2] : [0, 1]) : [0, 1, 2];
    const valuesFor = (actor: SerializedActor): [number, number, number] =>
      property === "rotation"
        ? quaternionToEulerDegrees(actor.transform.rotation)
        : [...actor.transform[property]];
    const primaryValues = valuesFor(primary);
    const mixedAxes = axes.map((axis) =>
      actors.some(
        (actor) =>
          Math.abs(valuesFor(actor)[axis]! - primaryValues[axis]!) > 1e-8,
      ),
    );
    const shownValues = (values: [number, number, number]) => {
      const shown: [number, number, number] = [0, 0, 0];
      axes.forEach((axis, index) => {
        shown[index] = values[axis]!;
      });
      return shown;
    };
    const value = shownValues(primaryValues);
    /** The actor with its shown axes set to `shown`; hidden axes keep its own values. */
    const withShown = (actor: SerializedActor, shown: Vector3Value): SerializedActor => {
      const next = valuesFor(actor);
      axes.forEach((axis, index) => {
        next[axis] = shown[index]!;
      });
      return {
        ...actor,
        transform: {
          ...actor.transform,
          [property]: property === "rotation" ? eulerDegreesToQuaternion(next) : next,
        },
      };
    };
    const apply = (values: Vector3Value, editedAxis?: number) => {
      updateSelected((actor) => {
        const shown = shownValues(valuesFor(actor));
        axes.forEach((_, index) => {
          if (editedAxis === undefined || editedAxis === index) shown[index] = values[index]!;
        });
        return withShown(actor, shown);
      });
    };
    rows.push({
      kind: "vector3",
      id: `actor-${property}`,
      label: { position: "Position", rotation: "Rotation", scale: "Scale" }[
        property
      ],
      value,
      defaultValue: property === "scale" ? [1, 1, twoD ? 0 : 1] : [0, 0, 0],
      axes: axes.map((axis) => ["X", "Y", "Z"][axis]!),
      mixed: mixedAxes.some(Boolean),
      mixedAxes,
      onChange: (next) => apply(next),
      onAxisChange: (axis, next) => {
        const values = [...value] as [number, number, number];
        values[axis] = next;
        apply(values, axis);
      },
      itemValues: actors.map((actor) => shownValues(valuesFor(actor))),
      onItemValuesChange: (itemValues) =>
        updateSelected((actor) => {
          const shown = itemValues[actorIndex.get(actor.id) ?? -1];
          return shown ? withShown(actor, shown) : actor;
        }),
      // Each actor keeps its own link; linked actors scale by their own factor.
      ...(property === "scale" && linkedScale
        ? {
            linked: actors.every((actor) => linkedScale.isLinked(scaleLinkKey.actor(actor.id))),
            onLinkedChange: (linked: boolean) =>
              linkedScale.setLinked(actors.map((actor) => scaleLinkKey.actor(actor.id)), linked),
            itemLinked: actors.map((actor) => linkedScale.isLinked(scaleLinkKey.actor(actor.id))),
          }
        : {}),
    });
    if (planar && property === "position") {
      rows.push({
        kind: "number",
        id: "actor-z-order",
        label: "Z-Order",
        value: zOrderFromDepth(primary.transform.position[2]),
        defaultValue: 0,
        mixed: actors.some(
          (actor) =>
            actor.transform.position[2] !== primary.transform.position[2],
        ),
        onChange: (order) => updateSelected((actor) => withZOrder(actor, order)),
        itemValues: actors.map((actor) => zOrderFromDepth(actor.transform.position[2])),
        onItemValuesChange: (orders) =>
          updateSelected((actor) => {
            const order = orders[actorIndex.get(actor.id) ?? -1];
            return order === undefined ? actor : withZOrder(actor, order);
          }),
      });
    }
  }
  return rows;
}

function withZOrder(actor: SerializedActor, order: number): SerializedActor {
  const [x, y] = actor.transform.position;
  return { ...actor, transform: { ...actor.transform, position: [x, y, depthFromZOrder(order)] } };
}
