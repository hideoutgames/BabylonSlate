import type { BakedLightingManifest } from "@babylonslate/core";
import { bakedReceiverKey } from "./baked-lighting";
import {
  decodeBakedGeometryAsset,
  type DecodedBakedGeometry,
} from "./baked-geometry";
import type { AssetRegistry } from "./registry";

export class StaleBakedGeometryError extends Error {}

/** A generated asset cannot be substituted for another Scene, receiver, or source generation. */
export async function loadBakedGeometryBindings(
  registry: AssetRegistry,
  manifest: BakedLightingManifest,
): Promise<ReadonlyMap<string, DecodedBakedGeometry>> {
  const result = new Map<string, DecodedBakedGeometry>();
  let bytes = 0;
  for (const receiver of manifest.receivers) {
    const reference = receiver.generatedGeometry;
    if (!reference) continue;
    if (result.size >= 64)
      throw new Error("Too many generated receiver geometries.");
    const asset = registry.getByGuid(reference.assetGuid);
    if (!asset || asset.placeholder)
      throw new Error("Generated receiver geometry is unavailable.");
    const container = await registry
      .storageFor(asset.rootId)
      .readBinary(asset.path);
    const geometry = await decodeBakedGeometryAsset(container, (hash) =>
      registry.blobsFor(asset.rootId).readBlob(hash),
    );
    if (
      geometry.guid !== reference.assetGuid ||
      geometry.manifest.contentHash !== reference.contentHash ||
      geometry.manifest.sceneGuid !== manifest.sceneGuid ||
      geometry.manifest.sourceHash !== receiver.hashes.geometry ||
      bakedReceiverKey(geometry.manifest.receiver) !==
        bakedReceiverKey(receiver.identity)
    )
      throw new StaleBakedGeometryError(
        "Generated receiver geometry identity or source is stale.",
      );
    bytes +=
      geometry.topology.indices.byteLength +
      geometry.topology.originalVertices.byteLength +
      geometry.topology.uv2.byteLength;
    if (bytes > 32 * 1024 * 1024)
      throw new Error(
        "Generated receiver geometries exceed their aggregate byte limit.",
      );
    result.set(bakedReceiverKey(receiver.identity), geometry);
  }
  return result;
}
