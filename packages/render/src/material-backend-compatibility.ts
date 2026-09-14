import { lowerMaterialDocument, type MaterialDocument, type MaterialFunctionDocument } from "@babylonslate/shader-graph";

/** Use the emitted function closure, so an unused Custom GLSL node does not change backends. */
export function webGpuMaterialCompatibilityReason(
  documents: ReadonlyMap<string, MaterialDocument>,
  functions: ReadonlyMap<string, MaterialFunctionDocument>,
): string | undefined {
  const context = { functions: Object.fromEntries(functions) };
  for (const [guid, document] of [...documents].sort(([a], [b]) => a.localeCompare(b))) {
    const result = lowerMaterialDocument(document, context);
    if (result.ok && result.plan.cost.customBlocks > 0) {
      return `Material "${document.name || guid}" uses Custom GLSL; using WebGL2.`;
    }
  }
  return undefined;
}
