import type { Vector3Value } from "./property-grid";

/**
 * Sets `axis` to `value` and, when `linked`, scales the other leading
 * `axisCount` axes by the same factor; hidden axes keep their values. A zero
 * base axis has no factor, so every shown axis takes `value`.
 */
export function editVectorAxis(
  base: Vector3Value,
  axis: number,
  value: number,
  axisCount: number,
  linked: boolean,
): Vector3Value {
  const from = base[axis] ?? 0;
  const next = [...base] as Vector3Value;
  for (let index = 0; index < axisCount; index++) {
    if (index === axis || (linked && from === 0)) next[index] = value;
    else if (linked) next[index] = (base[index] ?? 0) * (value / from);
  }
  return next;
}
