import type { MaterialParameterCatalog, MaterialParameterValue } from "@babylonslate/core";
import type { MaterialDocument, MaterialFunctionDocument } from "./document";
import { lowerMaterialDocument } from "./lower";

/** Match compiled parameter bindings: only reachable root parameters are public. */
export function buildMaterialParameterCatalog(
  documents: ReadonlyMap<string, MaterialDocument>,
  functions: ReadonlyMap<string, MaterialFunctionDocument> = new Map(),
): MaterialParameterCatalog {
  const result: Array<[string, MaterialParameterCatalog[string]]> = [];
  const context = { functions: Object.fromEntries(functions) };
  for (const [guid, document] of documents) {
    const lowered = lowerMaterialDocument(document, context);
    if (!lowered.ok) continue;
    const parameters: Array<[string, MaterialParameterValue]> = [];
    for (const operation of lowered.plan.operations) {
      if (operation.source.callPath.length || !operation.nodeType.startsWith("param.")) continue;
      const name = String(operation.properties.name ?? "").trim();
      if (!name) continue;
      // Same authored components as the compiler's InputBlock, before shader
      // color-space conversion. Non-finite values are not valid public defaults.
      const components = Array.isArray(operation.properties.value) ? operation.properties.value : [0];
      const [x = 0, y = 0, z = 0, w = 1] = components;
      if (operation.nodeType === "param.float" && typeof x === "number" && Number.isFinite(x))
        parameters.push([name, { kind: "float", value: x }]);
      else if (operation.nodeType === "param.color" && [x,y,z,w].every((v) => typeof v === "number" && Number.isFinite(v)))
        parameters.push([name, { kind: "color", value: [x,y,z,w] }]);
      else if (operation.nodeType === "param.texture")
        parameters.push([name, { kind: "texture", textureAssetGuid:
          typeof operation.properties.textureGuid === "string" ? operation.properties.textureGuid : null }]);
    }
    result.push([guid, { domain: lowered.plan.domain, planHash: lowered.plan.hash,
      parameters: Object.fromEntries(parameters) }]);
  }
  return Object.fromEntries(result);
}
