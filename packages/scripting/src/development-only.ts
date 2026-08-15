import type { GraphNode } from "./ir";

/**
 * Unreal-style Development Only: the node runs in editor Play, but export
 * compiles skip it (exec continues at `then` / Sequence `then_*`).
 *
 * Print defaults to development-only so shipping builds do not keep on-screen
 * debug text unless the author opts out.
 */
export function isDevelopmentOnlyNode(node: GraphNode): boolean {
  const flag = node.properties.developmentOnly;
  if (flag === true) return true;
  if (flag === false) return false;
  return node.typeId === "debug.print";
}
