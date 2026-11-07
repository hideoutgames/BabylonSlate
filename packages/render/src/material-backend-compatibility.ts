import { lowerMaterialDocument, type MaterialCatalogLowering, type MaterialDocument, type MaterialFunctionDocument } from "@haptic/shader-graph";

/**
 * Use the emitted function closure, so an unused Custom GLSL node does not change backends.
 * `lower` is `lowerMaterialDocumentCached` for documents nobody edits in place.
 */
export function webGpuMaterialCompatibilityReason(
  documents: ReadonlyMap<string, MaterialDocument>,
  functions: ReadonlyMap<string, MaterialFunctionDocument>,
  lower?: MaterialCatalogLowering,
): string | undefined {
  const context = { functions: Object.fromEntries(functions) };
  for (const [guid, document] of [...documents].sort(([a], [b]) => a.localeCompare(b))) {
    const result = lower ? lower(document, functions) : lowerMaterialDocument(document, context);
    if (result.ok && result.plan.cost.customBlocks > 0) {
      return `Material "${document.name || guid}" uses Custom GLSL; using WebGL2.`;
    }
  }
  return undefined;
}
