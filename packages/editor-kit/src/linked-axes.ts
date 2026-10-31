import { createContext } from "react";
import type { Vector3Value } from "./property-grid";

/** Link state shared by every `linkable` vector row; the editor persists it in app settings. */
export interface LinkedAxesSetting {
  linked: boolean;
  onLinkedChange: (linked: boolean) => void;
}

/** Without a provider each PropertyGrid keeps its own unsaved link state, off at first. */
export const LinkedAxesContext = createContext<LinkedAxesSetting | null>(null);

/**
 * Sets `axis` to `value` and scales the other leading `axisCount` axes by the
 * same factor; hidden axes keep their values. A zero base axis has no factor,
 * so every shown axis takes `value`.
 */
export function scaleLinkedAxes(
  base: Vector3Value,
  axis: number,
  value: number,
  axisCount: number,
): Vector3Value {
  const from = base[axis] ?? 0;
  const next = [...base] as Vector3Value;
  for (let index = 0; index < axisCount; index++) {
    next[index] = index === axis ? value : from === 0 ? value : (base[index] ?? 0) * (value / from);
  }
  return next;
}
