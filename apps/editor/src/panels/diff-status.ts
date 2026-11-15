import type { DiffStatus } from "@haptic/assets/asset-diff";
import type { DiffState } from "../services/source-control-diff";

type Changed = Exclude<DiffStatus, "unchanged">;

export const STATUS_LETTER: Record<Changed, string> = { added: "A", removed: "D", changed: "M" };
export const STATUS_LABEL: Record<Changed, string> = { added: "Added", removed: "Removed", changed: "Changed" };
/** The tree row tint of each status. */
export const STATUS_TONE = { added: "success", removed: "destructive", changed: "warning" } as const;

/** Whether a diff window has a result to show; a reload keeps showing the last one. */
export function hasDiff(state: DiffState): boolean {
  return state.diff !== null && state.phase !== "error";
}
