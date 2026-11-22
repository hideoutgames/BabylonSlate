import type { DiffStatus, GraphNodeDiff } from "@haptic/assets/asset-diff";
import type { DiffState } from "../services/source-control-diff";

type Changed = Exclude<DiffStatus, "unchanged">;

export const STATUS_LABEL: Record<Changed, string> = { added: "Added", removed: "Removed", changed: "Changed" };
/** The tree row tint of each status. */
export const STATUS_TONE = { added: "success", removed: "destructive", changed: "warning" } as const;

/** Whether a diff window has a result to show; a reload keeps showing the last one. */
export function hasDiff(state: DiffState): boolean {
  return state.diff !== null && state.phase !== "error";
}

/** The Actors window's first row: the asset itself (its header, chunks and document-level fields). */
export const ASSET_ITEM = "asset";

/** The Actors window's id of a property group: `group:<group id>` (for Project Settings, a dialog category). */
export const GROUP_PREFIX = "group:";

/** One line for a changed node: its first changed pin value, or what else changed. */
export function nodeSummary(node: GraphNodeDiff): string {
  const pin = node.pins[0];
  if (pin) return `${pin.name}: ${pin.base ?? "None"} → ${pin.compare ?? "None"}`;
  const field = node.fields[0];
  if (field) return field.label;
  if (node.status !== "changed") return node.connections === 1 ? "Node And 1 Wire" : `Node And ${node.connections} Wires`;
  if (node.moved) return "Moved";
  return node.connections === 1 ? "1 Wire" : `${node.connections} Wires`;
}
