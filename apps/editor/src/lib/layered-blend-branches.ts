import { normalizeAnimBranchFilters, type AnimBranchFilter } from "@haptic/core";
import { layeredBlendInputCount } from "@haptic/anim-graph";

/** Each blend input's branch filters as a Layered Blend Per Bone stores them (`layers[i].branches`). */
export function layeredBlendBranchLists(data: Record<string, unknown>): AnimBranchFilter[][] {
  const layers = Array.isArray(data.layers) ? data.layers : [];
  return Array.from({ length: layeredBlendInputCount(data.count) }, (_, index) =>
    normalizeAnimBranchFilters((layers[index] as { branches?: unknown } | undefined)?.branches));
}

/** The node data with blend input `index`'s branch filters replaced. */
export function patchLayeredBlendBranches(
  data: Record<string, unknown>,
  index: number,
  branches: AnimBranchFilter[],
): Record<string, unknown> {
  const lists = layeredBlendBranchLists(data);
  lists[index] = branches;
  return { layers: lists.map((list) => ({ branches: list })) };
}
