import type { PropertyRow } from "@babylonslate/editor-kit";
import {
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  quaternionToEulerDegrees,
  type SerializedTransform,
  type ViewportMode,
} from "@babylonslate/core";

/** Position / rotation / scale rows; 2D splits Position Z out as Z-Order. */
export function spatialTransformPropertyRows(
  idPrefix: string,
  viewportMode: ViewportMode,
  transform: SerializedTransform,
  onUpdateTransform: (next: SerializedTransform) => void,
  defaults?: SerializedTransform,
): PropertyRow[] {
  const twoD = viewportMode === "2d";
  const reset = defaults ?? identitySerializedTransform();
  const defaultEuler = quaternionToEulerDegrees(reset.rotation);
  const rows: PropertyRow[] = [
    {
      kind: "vector3",
      id: `${idPrefix}-position`,
      label: "Position",
      value: transform.position,
      defaultValue: [...reset.position] as [number, number, number],
      axes: twoD ? ["X", "Y"] : ["X", "Y", "Z"],
      onChange: (position) =>
        onUpdateTransform({
          ...transform,
          position: [position[0], position[1], position[2]],
        }),
    },
  ];
  if (twoD) {
    rows.push({
      kind: "number",
      id: `${idPrefix}-z-order`,
      label: "Z-Order",
      value: zOrderFromDepth(transform.position[2]),
      defaultValue: zOrderFromDepth(reset.position[2]),
      onChange: (order) =>
        onUpdateTransform({
          ...transform,
          position: [transform.position[0], transform.position[1], depthFromZOrder(order)],
        }),
    });
  }
  rows.push(
    {
      kind: "vector3",
      id: `${idPrefix}-rotation`,
      label: "Rotation",
      value: twoD
        ? [quaternionToEulerDegrees(transform.rotation)[2], 0, 0]
        : quaternionToEulerDegrees(transform.rotation),
      defaultValue: twoD ? [defaultEuler[2], 0, 0] : defaultEuler,
      axes: twoD ? ["Z"] : ["X", "Y", "Z"],
      onChange: (next) =>
        onUpdateTransform({
          ...transform,
          rotation: eulerDegreesToQuaternion(
            twoD ? [0, 0, next[0]] : [next[0], next[1], next[2]],
          ),
        }),
    },
    {
      kind: "vector3",
      id: `${idPrefix}-scale`,
      label: "Scale",
      value: transform.scale,
      defaultValue: [...reset.scale] as [number, number, number],
      axes: twoD ? ["X", "Y"] : ["X", "Y", "Z"],
      onChange: (scale) =>
        onUpdateTransform({
          ...transform,
          scale: [scale[0], scale[1], scale[2]],
        }),
    },
  );
  return rows;
}

/**
 * The 2D camera sits on -Z looking toward +Z, so a nearer (smaller) world Z
 * draws in front. Z-Order counts the other way: a higher order is in front.
 */
export function zOrderFromDepth(z: number): number {
  return z === 0 ? 0 : -z;
}

export function depthFromZOrder(order: number): number {
  return order === 0 ? 0 : -order;
}
