import type { PropertyRow, Vector3Value } from "@haptic/editor-kit";
import {
  eulerDegreesToQuaternion,
  quaternionToEulerDegrees,
  type SerializedActor,
} from "@haptic/core";
import { depthFromZOrder, zOrderFromDepth, type TransformRowsMode } from "./transform-property-rows";

/** Shared axis edits are absolute values; other axes retain each actor's values. */
export function selectionTransformPropertyRows(
  actors: readonly SerializedActor[],
  mode: TransformRowsMode,
  updateSelected: (update: (actor: SerializedActor) => SerializedActor) => void,
): PropertyRow[] {
  const primary = actors[0];
  if (!primary) return [];
  const planar = mode !== "3d";
  const twoD = mode === "2d";
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
    const apply = (values: Vector3Value, editedAxis?: number) => {
      updateSelected((actor) => {
        const next = valuesFor(actor);
        axes.forEach((axis, index) => {
          if (editedAxis === undefined || editedAxis === index)
            next[axis] = values[index]!;
        });
        return {
          ...actor,
          transform: {
            ...actor.transform,
            [property]:
              property === "rotation" ? eulerDegreesToQuaternion(next) : next,
          },
        };
      });
    };
    const shownValues = (values: [number, number, number]) => {
      const shown: [number, number, number] = [0, 0, 0];
      axes.forEach((axis, index) => {
        shown[index] = values[axis]!;
      });
      return shown;
    };
    const value = shownValues(primaryValues);
    const actorIndex = new Map(actors.map((actor, index) => [actor.id, index]));
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
      // Linked Scale edits scale each actor by its own factor.
      ...(property === "scale"
        ? {
            linkable: true,
            itemValues: actors.map((actor) => shownValues(valuesFor(actor))),
            onItemValuesChange: (itemValues: Vector3Value[]) =>
              updateSelected((actor) => {
                const shown = itemValues[actorIndex.get(actor.id) ?? -1];
                if (!shown) return actor;
                const next = valuesFor(actor);
                axes.forEach((axis, index) => {
                  next[axis] = shown[index]!;
                });
                return { ...actor, transform: { ...actor.transform, scale: next } };
              }),
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
        onChange: (order) =>
          updateSelected((actor) => ({
            ...actor,
            transform: {
              ...actor.transform,
              position: [
                actor.transform.position[0],
                actor.transform.position[1],
                depthFromZOrder(order),
              ],
            },
          })),
      });
    }
  }
  return rows;
}
