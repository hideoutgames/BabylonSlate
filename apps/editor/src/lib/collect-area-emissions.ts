import { areaEmissionTextureGuids, materialParameterTextureGuidsFromGraph, type SerializedGraph, type SerializedScene } from "@babylonslate/core";
import { currentAreaEmissionChunk, decodeAreaEmission, type AreaEmissionPixels, type IndexedAsset } from "@babylonslate/assets";

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
  for (const guid of candidates) {
    const asset = byGuid.get(guid);
    const chunk = asset && currentAreaEmissionChunk(asset.header);
    if (!chunk) {
      if (required.has(guid)) options.onDiagnostic(`Texture ${asset?.header.name ?? guid} needs Prepare Emission before it can illuminate a rectangular light.`);
      continue;
    }
    try {
      const bytes = await options.readChunk(asset!.path, chunk.id);
      if (!bytes) throw new Error("Prepared emission chunk is missing.");
      result.set(guid, await decodeAreaEmission(bytes));
    } catch (error) { options.onDiagnostic(`Area emission ${asset!.header.name}: ${String(error)}`); }
  }
  return result;
}
