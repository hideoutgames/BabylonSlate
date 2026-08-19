import type { PropertyRow } from "@babylonslate/editor-kit";
import {
  eulerDegreesToQuaternion,
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
): PropertyRow[] {
  const twoD = viewportMode === "2d";
  const rows: PropertyRow[] = [
    {
      kind: "vector3",
      id: `${idPrefix}-position`,
      label: "Position",
      value: transform.position,
      defaultValue: [0, 0, 0],
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
      value: transform.position[2],
      defaultValue: 0,
      onChange: (z) =>
        onUpdateTransform({
          ...transform,
          position: [transform.position[0], transform.position[1], z],
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
      defaultValue: [0, 0, 0],
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
      defaultValue: [1, 1, 1],
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
