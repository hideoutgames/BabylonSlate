import { areaEmissionTextureGuids, materialParameterTextureGuidsFromGraph, type SerializedGraph, type SerializedScene } from "@haptic/core";
import { currentAreaEmissionChunk, decodeAreaEmission, mapBounded, type AreaEmissionPixels, type IndexedAsset } from "@haptic/assets";
import { COLLECTOR_READS } from "./play-content";

/** Observe only referenced prepared content, not unrelated registry activity. */
export function savedAreaEmissionKey(guids: readonly string[], lookup: (guid: string) => IndexedAsset | undefined): string {
  return JSON.stringify(guids.map((guid) => {
    const asset = lookup(guid);
    const chunk = asset && currentAreaEmissionChunk(asset.header);
    return [guid, chunk?.id ?? null, chunk?.sha256 ?? null];
  }));
}

export async function collectAreaEmissions(options: {
  assets: readonly IndexedAsset[];
  scenes: readonly (SerializedScene | null | undefined)[];
  graphs?: readonly SerializedGraph[];
  readChunk: (path: string, id: string) => Promise<Uint8Array | null>;
  onDiagnostic: (message: string) => void;
}): Promise<Map<string, AreaEmissionPixels>> {
  const required = new Set(areaEmissionTextureGuids([options.scenes, options.graphs]));
  // Typed Texture variables can be assigned to emitters by a later script call.
  const candidates = new Set([...required, ...(options.graphs ?? []).flatMap(materialParameterTextureGuidsFromGraph)]);
  const byGuid = new Map(options.assets.map((asset) => [asset.header.guid, asset]));
  const result = new Map<string, AreaEmissionPixels>();
  const entries = [...candidates].map((guid) => {
    const asset = byGuid.get(guid);
    return { guid, asset, chunk: asset && currentAreaEmissionChunk(asset.header) };
  });
  const decoded = await mapBounded(entries, COLLECTOR_READS, async ({ asset, chunk }) => {
    if (!asset || !chunk) return null;
    try {
      const bytes = await options.readChunk(asset.path, chunk.id);
      if (!bytes) throw new Error("Prepared emission chunk is missing.");
      return { ok: true as const, pixels: await decodeAreaEmission(bytes) };
    } catch (error) { return { ok: false as const, error }; }
  });
  // Reported in candidate order, as a serial pass reports them.
  for (const [index, { guid, asset }] of entries.entries()) {
    const outcome = decoded[index];
    if (!outcome) {
      if (required.has(guid)) options.onDiagnostic(`Texture ${asset?.header.name ?? guid} needs Prepare Emission before it can illuminate a rectangular light.`);
    } else if (outcome.ok) result.set(guid, outcome.pixels);
    else options.onDiagnostic(`Area emission ${asset!.header.name}: ${String(outcome.error)}`);
  }
  return result;
}
