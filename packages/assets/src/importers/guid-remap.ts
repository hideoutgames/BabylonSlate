import { remapAnimationPayloadGuids } from "../animation-payload";
import { remapAudioPayloadGuids } from "../audio-payload";
import { newAssetGuid } from "../guid";
import { remapModelPayloadGuids } from "../model-payload";
import { remapParticlePayloadGuids } from "../particle-payload";
import { remapSkeletonPayloadGuids } from "../skeleton-payload";
import { remapRenderTargetPayloadGuids } from "../render-target-payload";
import { remapDataPayloadGuids, type DataDefinitionFieldsResolver } from "../data-asset-refs";
import type { ImportResult } from "./types";

const DATA_TYPES = new Set(["DataDefinition", "DataTree", "Structure", "Enum"]);

function remapDocumentPayload(type: string, payload: Record<string, unknown>, remap: ReadonlyMap<string, string>, definitionFields: DataDefinitionFieldsResolver): Record<string, unknown> {
  if (DATA_TYPES.has(type)) return remapDataPayloadGuids(type, payload, remap, definitionFields);
  const targets = remapRenderTargetPayloadGuids(type, payload, remap);
  return remapDataPayloadGuids(type, remapInputReferences(targets, remap), remap, definitionFields) as Record<string, unknown>;
}

function remapHeaderPayload(type: string, payload: Record<string, unknown>, remap: ReadonlyMap<string, string>, definitionFields: DataDefinitionFieldsResolver): Record<string, unknown> {
  if (DATA_TYPES.has(type)) return remapDataPayloadGuids(type, payload, remap, definitionFields);
  let next = remapAudioPayloadGuids(type, payload, remap);
  next = remapParticlePayloadGuids(type, next, remap);
  next = remapModelPayloadGuids(type, next, remap);
  next = remapSkeletonPayloadGuids(type, next, remap);
  next = remapAnimationPayloadGuids(type, next, remap);
  return remapDocumentPayload(type, next, remap, definitionFields);
}

/**
 * Rewrite any guid in `results` that collides with `existingGuids`,
 * rewriting every result's `dependencies` list (and the entry's own
 * `attachToGuid`, when it points inside the same batch) so the set stays
 * internally consistent. Cross-project import remaps colliding guids;
 * template instantiate keeps guids as-is by never calling this with a
 * colliding set.
 */
export function remapImportResultGuids(
  results: ImportResult[],
  existingGuids: ReadonlySet<string>,
): ImportResult[] {
  const remap = new Map<string, string>();
  for (const result of results) {
    if (existingGuids.has(result.guid)) {
      remap.set(result.guid, newAssetGuid());
    }
  }
  if (remap.size === 0) {
    return results;
  }
  const definitions = new Map<string, readonly unknown[]>();
  for (const result of results) {
    let payload = result.payload;
    const chunk = result.chunks.find((entry) => entry.id === "document");
    if (chunk && (result.type === "DataDefinition" || result.type === "Structure")) {
      try {
        const document: unknown = JSON.parse(new TextDecoder().decode(chunk.data));
        if (document && typeof document === "object" && !Array.isArray(document)) payload = document as Record<string, unknown>;
      }
      catch { /* An unreadable document is handled by its normal import validation. */ }
    }
    if (result.type === "DataObject" || result.type === "DataSheet") {
      throw new Error("Historical Data Object and Data Sheet assets cannot be imported with GUID collisions. Their original files have not been changed.");
    }
    if ((result.type === "DataDefinition" || result.type === "Structure") && Array.isArray(payload.fields)) definitions.set(result.guid, payload.fields);
  }
  const definitionFields: DataDefinitionFieldsResolver = (guid) => definitions.get(guid);
  return results.map((result) => ({
    ...result,
    guid: remap.get(result.guid) ?? result.guid,
    dependencies: result.dependencies.map((dep) => remap.get(dep) ?? dep),
    requiredDependencies: result.requiredDependencies?.map((dep) => remap.get(dep) ?? dep),
    chunks: result.chunks.map((chunk) => {
      if (chunk.id !== "document") return chunk;
      try {
        const mapped = remapDocumentPayload(result.type, JSON.parse(new TextDecoder().decode(chunk.data)), remap, definitionFields);
        return { ...chunk, data: new TextEncoder().encode(JSON.stringify(mapped)) };
      } catch { return chunk; }
    }),
    payload: remapHeaderPayload(result.type, result.payload, remap, definitionFields),
    attachToGuid: result.attachToGuid
      ? remap.get(result.attachToGuid) ?? result.attachToGuid
      : result.attachToGuid,
  }));
}

/** InputType defaults can be nested inside variables, arrays, and function graphs. */
function remapInputReferences(value: unknown, remap: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapInputReferences(entry, remap));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).map(([key, entry]) => [key,
    key === "default:values" && Array.isArray(row.dataSchema) ? entry
      : key === "Asset" && typeof row.Name === "string" && typeof entry === "string" ? remap.get(entry) ?? entry : remapInputReferences(entry, remap),
  ]));
}
