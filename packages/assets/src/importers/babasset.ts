import { decodeBabasset } from "../babasset";
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
  return remapImportResultGuids(results, options.existingGuids);
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
