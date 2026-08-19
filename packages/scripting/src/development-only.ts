import type { GraphNode } from "./ir";

/**
 * Unreal-style Development Only: the node runs in editor Play, but export
 * compiles skip it (exec continues at `then` / Sequence `then_*`).
 *
 * Print / Print String / Draw Debug default on so shipping builds omit them
 * unless the author unchecks Development Only.
 */
const developmentOnlyByDefaultTypeIds = new Set<string>([
  "debug.print",
  "debug.printString",
]);

export function registerDevelopmentOnlyByDefaultTypeId(typeId: string): void {
  developmentOnlyByDefaultTypeIds.add(typeId);
}

export function isDevelopmentOnlyByDefaultTypeId(typeId: string): boolean {
  return developmentOnlyByDefaultTypeIds.has(typeId);
}

export function isDevelopmentOnlyNode(node: GraphNode): boolean {
  const flag = node.properties.developmentOnly;
  if (flag === true) return true;
  if (flag === false) return false;
  return isDevelopmentOnlyByDefaultTypeId(node.typeId);
}
