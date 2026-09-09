type TreeGuideSegment = "full" | "end" | null;

/** Resolve sibling continuations before windowing so off-screen rows still join correctly. */
export function treeGuideSegments(
  nodes: readonly { depth: number }[],
): TreeGuideSegment[][] {
  const nextAtDepth: number[] = [];
  const hasNextSibling: boolean[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const depth = nodes[index]!.depth;
    nextAtDepth.length = depth + 1;
    hasNextSibling[index] = nextAtDepth[depth] !== undefined;
    nextAtDepth[depth] = index;
  }
  const ancestorContinues: boolean[] = [];
  return nodes.map((node, index) => {
    const segments = Array.from(
      { length: node.depth },
      (_, level): TreeGuideSegment =>
        level === node.depth - 1
          ? hasNextSibling[index]
            ? "full"
            : "end"
          : ancestorContinues[level + 1]
            ? "full"
            : null,
    );
    ancestorContinues.length = node.depth + 1;
    ancestorContinues[node.depth] = hasNextSibling[index]!;
    return segments;
  });
}
