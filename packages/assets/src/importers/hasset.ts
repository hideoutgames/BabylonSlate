import { decodeHasset, type HassetHeader } from "../hasset";
import {
  formatImportBytes,
  formatImportCount,
  HASSET_MAX_NESTED_ASSETS,
  HASSET_MAX_NESTED_BYTES,
  HASSET_MAX_NESTING_DEPTH,
  ImportLimitError,
  importLimitError,
} from "../import-limits";
import { remapImportResultGuids } from "./guid-remap";
import type { ImportOptions, ImportResult } from "./types";

/**
 * Unpacks an incoming `.hasset` (and any bundled-mode nested assets) into
 * one `ImportResult` per asset, remapping guids that collide with the
 * destination project so header, dependency and nested references all stay
 * consistent. Chunks must be inline: a pure importer has no blob store, so a
 * thin-mode file with externalised blobs cannot be re-hydrated here.
 *
 * Nested assets are bounded by {@link HASSET_MAX_NESTING_DEPTH} levels,
 * {@link HASSET_MAX_NESTED_ASSETS} assets and {@link HASSET_MAX_NESTED_BYTES}
 * bytes, all levels together, each checked from its parent's chunk table
 * before the nested file is decoded.
 */
export async function importHasset(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  await collect(bytes, results, 0, { assets: 0, bytes: 0 });
  return remapImportResultGuids(results, options.existingGuids);
}

interface NestedBudget {
  assets: number;
  bytes: number;
}

function isNestedAssetChunk(entry: { kind: string; id: string }): boolean {
  return entry.kind === "asset" && entry.id.startsWith("nested:");
}

/**
 * Charges a file's nested assets to `budget` from its chunk table, before any
 * of them is decoded. Decoding the file itself hashed them once; inline chunks
 * never overlap, so that costs no more than the file's own size.
 */
function chargeNestedAssets(header: HassetHeader, depth: number, budget: NestedBudget): void {
  const nested = header.chunks.filter(isNestedAssetChunk);
  if (nested.length === 0) return;
  if (depth + 1 > HASSET_MAX_NESTING_DEPTH) {
    throw new ImportLimitError(
      `The asset nests other assets more than ${HASSET_MAX_NESTING_DEPTH} levels deep; the import limit is ${HASSET_MAX_NESTING_DEPTH}. Export the assets on their own.`,
    );
  }
  budget.assets += nested.length;
  if (budget.assets > HASSET_MAX_NESTED_ASSETS) {
    throw importLimitError(
      "The number of assets nested inside the file",
      `at least ${formatImportCount(budget.assets)}`,
      formatImportCount(HASSET_MAX_NESTED_ASSETS),
      "Export fewer assets together.",
    );
  }
  for (const entry of nested) budget.bytes += entry.byteLength;
  if (budget.bytes > HASSET_MAX_NESTED_BYTES) {
    throw importLimitError(
      "The size of the assets nested inside the file",
      `at least ${formatImportBytes(budget.bytes)}`,
      formatImportBytes(HASSET_MAX_NESTED_BYTES),
      "Export fewer assets together.",
    );
  }
}

async function collect(bytes: Uint8Array, out: ImportResult[], depth: number, budget: NestedBudget): Promise<void> {
  const decoded = await decodeHasset(bytes);
  chargeNestedAssets(decoded.header, depth, budget);
  const chunks = decoded.header.chunks
    .filter((entry) => !isNestedAssetChunk(entry))
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
    requiredDependencies: decoded.header.requiredDependencies ? [...decoded.header.requiredDependencies] : undefined,
    dependencyMetadataVersion: decoded.header.dependencyMetadataVersion,
    classReferences: decoded.header.classReferences,
    requiredClassReferences: decoded.header.requiredClassReferences,
    consoleCommand: decoded.header.consoleCommand,
    requiredVariableNames: decoded.header.requiredVariableNames ? [...decoded.header.requiredVariableNames] : undefined,
    parentClass: decoded.header.parentClass ?? null,
    payload: decoded.header.payload,
    chunks,
  });

  for (const nestedBytes of decoded.nestedAssets.values()) {
    await collect(nestedBytes, out, depth + 1, budget);
  }
}
