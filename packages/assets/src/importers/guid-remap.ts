import { newAssetGuid } from "../guid";
import { remapAudioPayloadGuids } from "../audio-payload";
import { remapParticlePayloadGuids } from "../particle-payload";
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
    payload: remapParticlePayloadGuids(
      result.type,
      remapAudioPayloadGuids(result.type, result.payload, remap),
      remap,
    ),
    attachToGuid: result.attachToGuid
      ? remap.get(result.attachToGuid) ?? result.attachToGuid
      : result.attachToGuid,
  }));
}
