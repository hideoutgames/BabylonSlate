/**
 * Whether two values are equal once every node's `position` is ignored: a node
 * is any element of an array held under a `nodes` key (a graph's, or each of
 * its function graphs'). Shared sub-objects compare by identity first.
 */
export function equalIgnoringNodePositions(left: unknown, right: unknown, isNode = false): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    if (left.length !== other.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!equalIgnoringNodePositions(left[index], other[index], isNode)) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => !(isNode && key === "position") && a[key] !== undefined);
  const otherKeys = Object.keys(b).filter((key) => !(isNode && key === "position") && b[key] !== undefined);
  if (keys.length !== otherKeys.length) return false;
  for (const key of keys) {
    if (!(key in b)) return false;
    if (!equalIgnoringNodePositions(a[key], b[key], !isNode && key === "nodes")) return false;
  }
  return true;
}

/**
 * A selector, one per component (`useState(createPositionFreeGraphSelector)`), that returns the
 * graph it returned last while the new one differs only in node positions, so work that never
 * reads a position (validation, member symbols) can key on it and skip a moved node. Called again
 * with the same graph, it answers the same.
 */
export function createPositionFreeGraphSelector<T>(): (graph: T) => T {
  let kept: { graph: T } | null = null;
  let seen: { graph: T; result: T } | null = null;
  return (graph) => {
    if (seen && seen.graph === graph) return seen.result;
    const result = kept && equalIgnoringNodePositions(kept.graph, graph) ? kept.graph : graph;
    kept = { graph: result };
    seen = { graph, result };
    return result;
  };
}
