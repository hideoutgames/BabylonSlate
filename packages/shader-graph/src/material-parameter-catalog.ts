import type {
  MaterialParameterCatalog,
  MaterialParameterValue,
} from "@haptic/core";
import type { MaterialDocument, MaterialFunctionDocument } from "./document";
import { lowerMaterialDocumentCached, type MaterialBuildPlan } from "./lower";

const NO_FUNCTIONS: ReadonlyMap<string, MaterialFunctionDocument> = new Map();

/**
 * Each functions Map's record for the lowering cache. A host syncs one Map in place as sources
 * load and release, so the record is rebuilt whenever its entries (guids or document objects)
 * change: a newly loaded or released Material Function never meets a stale cached lowering.
 */
const functionRecords = new WeakMap<
  ReadonlyMap<string, MaterialFunctionDocument>,
  { entries: ReadonlyArray<readonly [string, MaterialFunctionDocument]>; record: Record<string, MaterialFunctionDocument> }
>();

function functionsRecord(functions: ReadonlyMap<string, MaterialFunctionDocument>): Record<string, MaterialFunctionDocument> {
  const cached = functionRecords.get(functions);
  if (cached && cached.entries.length === functions.size) {
    let index = 0;
    let same = true;
    for (const [guid, document] of functions) {
      const entry = cached.entries[index++]!;
      if (entry[0] !== guid || entry[1] !== document) { same = false; break; }
    }
    if (same) return cached.record;
  }
  const entries = [...functions];
  const record = Object.fromEntries(entries);
  functionRecords.set(functions, { entries, record });
  return record;
}

/**
 * Match compiled parameter bindings: only reachable root parameters are public. For Play and
 * packaged content, whose documents are never edited in place: each lowering is remembered per
 * document and functions (`lowerMaterialDocumentCached`).
 */
export function buildMaterialParameterCatalog(
  documents: ReadonlyMap<string, MaterialDocument>,
  functions: ReadonlyMap<string, MaterialFunctionDocument> = NO_FUNCTIONS,
): MaterialParameterCatalog {
  const result: Array<[string, MaterialParameterCatalog[string]]> = [];
  const record = functionsRecord(functions);
  for (const [guid, document] of documents) {
    const lowered = lowerMaterialDocumentCached(document, record);
    if (!lowered.ok) continue;
    result.push([
      guid,
      {
        domain: lowered.plan.domain,
        planHash: lowered.plan.hash,
        parameters: materialParameterDefaults(lowered.plan),
      },
    ]);
  }
  return Object.fromEntries(result);
}

/** Owned authored defaults from an already function-resolved plan; never allocates a Material. */
export function materialParameterDefaults(plan: MaterialBuildPlan): Record<string, MaterialParameterValue> {
  const parameters: Array<[string, MaterialParameterValue]> = [];
  for (const operation of plan.operations) {
    if (
      operation.source.callPath.length ||
      !operation.nodeType.startsWith("param.")
    )
      continue;
    const name = String(operation.properties.name ?? "").trim();
    if (!name) continue;
    // Same authored components as the compiler's InputBlock, before shader
    // color-space conversion. Non-finite values are not valid public defaults.
    const components = Array.isArray(operation.properties.value)
      ? operation.properties.value
      : [0];
    const [x = 0, y = 0, z = 0, w = 1] = components;
    if (
      operation.nodeType === "param.float" &&
      typeof x === "number" &&
      Number.isFinite(x)
    )
      parameters.push([name, { kind: "float", value: x }]);
    else if (
      operation.nodeType === "param.vec2" &&
      [x, y].every((v) => typeof v === "number" && Number.isFinite(v))
    )
      parameters.push([name, { kind: "vec2", value: [x, y] }]);
    else if (
      operation.nodeType === "param.vec3" &&
      [x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))
    )
      parameters.push([name, { kind: "vec3", value: [x, y, z] }]);
    else if (
      operation.nodeType === "param.color" &&
      [x, y, z, w].every((v) => typeof v === "number" && Number.isFinite(v))
    )
      parameters.push([name, { kind: "color", value: [x, y, z, w] }]);
    else if (operation.nodeType === "param.texture")
      parameters.push([
        name,
        {
          kind: "texture",
          textureAssetGuid:
            typeof operation.properties.textureGuid === "string"
              ? operation.properties.textureGuid
              : null,
        },
      ]);
  }
  return Object.fromEntries(parameters);
}
