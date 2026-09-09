import { remapAnimationPayloadGuids } from "../animation-payload";
import { remapAudioPayloadGuids } from "../audio-payload";
import { newAssetGuid } from "../guid";
import { remapModelPayloadGuids } from "../model-payload";
import { remapParticlePayloadGuids } from "../particle-payload";
import { remapSkeletonPayloadGuids } from "../skeleton-payload";
import type { ImportResult } from "./types";

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
  return results.map((result) => ({
    ...result,
    guid: remap.get(result.guid) ?? result.guid,
    dependencies: result.dependencies.map((dep) => remap.get(dep) ?? dep),
    chunks: result.chunks.map((chunk) => {
      if (chunk.id !== "document") return chunk;
      try {
        const body = JSON.parse(new TextDecoder().decode(chunk.data));
        return { ...chunk, data: new TextEncoder().encode(JSON.stringify(remapInputReferences(body, remap))) };
      } catch { return chunk; }
    }),
    payload: remapInputReferences(remapAnimationPayloadGuids(
      result.type,
      remapSkeletonPayloadGuids(
        result.type,
        remapModelPayloadGuids(
          result.type,
          remapParticlePayloadGuids(
            result.type,
            remapAudioPayloadGuids(result.type, result.payload, remap),
            remap,
          ),
          remap,
        ),
        remap,
      ),
      remap,
    ), remap) as Record<string, unknown>,
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
    key === "Asset" && typeof row.Name === "string" && typeof entry === "string" ? remap.get(entry) ?? entry : remapInputReferences(entry, remap),
  ]));
}
