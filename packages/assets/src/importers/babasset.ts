import { decodeBabasset } from "../babasset";
import { BAKED_LIGHTING_ASSET_TYPE, validateBakedLightingChunks } from "../baked-lighting";
import { BAKED_GEOMETRY_ASSET_TYPE, validateBakedGeometryChunks, encodeBakeTopology } from "../baked-geometry";
import { stableStringify } from "../bytes";
import { remapImportResultGuids } from "./guid-remap";
import type { ImportOptions, ImportResult } from "./types";

/**
 * Unpacks an incoming `.babasset` (and any bundled-mode nested assets) into
 * one `ImportResult` per asset, remapping guids that collide with the
 * destination project so header, dependency and nested references all stay
 * consistent. Chunks must be inline: a pure importer has no blob store, so a
 * thin-mode file with externalised blobs cannot be re-hydrated here.
 */
export async function importBabasset(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  await collect(bytes, results);
  const remapped = remapImportResultGuids(results, options.existingGuids);
  for (const [index, result] of remapped.entries()) {
    if (result.type !== BAKED_LIGHTING_ASSET_TYPE && result.type !== BAKED_GEOMETRY_ASSET_TYPE) continue;
    // V1 source identities/hashes cannot be silently rewritten by generic import.
    const original = results[index]!;
    if (original.dependencies.some((guid, dependencyIndex) => guid !== result.dependencies[dependencyIndex]))
      throw new Error("Baked lighting source GUID remapping requires a new bake; import sources without collisions.");
    if (result.type === BAKED_LIGHTING_ASSET_TYPE) await validateBakedLightingChunks(result, result.chunks);
    else await validateBakedGeometryChunks(result, result.chunks);
  }
  return remapped;
}

async function collect(bytes: Uint8Array, out: ImportResult[]): Promise<void> {
  const decoded = await decodeBabasset(bytes);
  const chunks = decoded.header.chunks
    .filter((entry) => !(entry.kind === "asset" && entry.id.startsWith("nested:")))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      mime: entry.mime,
      data: decoded.chunks.get(entry.id) ?? new Uint8Array(0),
    }));

  if (decoded.header.type === BAKED_LIGHTING_ASSET_TYPE) {
    const validated = await validateBakedLightingChunks(decoded.header, chunks);
    // Import owns the validated snapshots, not views into the caller's container.
    chunks.find((chunk) => chunk.id === "document")!.data = new TextEncoder().encode(stableStringify(validated.manifest));
    for (const atlas of validated.manifest.atlases)
      chunks.find((chunk) => chunk.id === atlas.chunkId)!.data = validated.atlases.get(atlas.guid)!;
  }
  if (decoded.header.type === BAKED_GEOMETRY_ASSET_TYPE) {
    const validated = await validateBakedGeometryChunks(decoded.header, chunks);
    chunks.find((chunk) => chunk.id === "document")!.data = new TextEncoder().encode(stableStringify(validated.manifest));
    chunks.find((chunk) => chunk.id === "topology")!.data = encodeBakeTopology(validated.topology, validated.manifest.sourceVertexCount);
  }

  out.push({
    type: decoded.header.type,
    name: decoded.header.name,
    guid: decoded.header.guid,
    version: decoded.header.version,
    dependencies: [...decoded.header.dependencies],
    parentClass: decoded.header.parentClass ?? null,
    payload: decoded.header.payload,
    chunks,
  });

  for (const nestedBytes of decoded.nestedAssets.values()) {
    await collect(nestedBytes, out);
  }
}
