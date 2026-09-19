import type { BakedLightingManifest } from "@babylonslate/core";
import { bakedReceiverKey } from "./baked-lighting";
import {
  decodeBakedGeometryAsset,
  type DecodedBakedGeometry,
} from "./baked-geometry";
import type { AssetRegistry } from "./registry";
import type { BakeRuntimeAssetReader } from "./baked-lighting-runtime";
import { awaitBakeRuntimeRead } from "./bake-runtime-read";

export class StaleBakedGeometryError extends Error {}

/** A generated asset cannot be substituted for another Scene, receiver, or source generation. */
export async function loadBakedGeometryBindings(
  registry: AssetRegistry,
  manifest: BakedLightingManifest,
): Promise<ReadonlyMap<string, DecodedBakedGeometry>> {
  return loadBakedGeometryArtifacts(async (guid) => {
    const asset = registry.getByGuid(guid);
    if (!asset || asset.placeholder) return undefined;
    return {
      bytes: await registry.storageFor(asset.rootId).readBinary(asset.path),
      readBlob: (hash) => registry.blobsFor(asset.rootId).readBlob(hash),
    };
  }, manifest);
}

/** The same strict identity checks apply to editor storage and exported runtime payloads. */
export async function loadBakedGeometryArtifacts(
  readAsset: BakeRuntimeAssetReader,
  manifest: BakedLightingManifest,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, DecodedBakedGeometry>> {
  const sceneGuid = manifest.sceneGuid;
  const receivers = structuredClone(manifest.receivers);
  const result = new Map<string, DecodedBakedGeometry>();
  let bytes = 0;
  for (const receiver of receivers) {
    signal?.throwIfAborted();
    const reference = receiver.generatedGeometry;
    if (!reference) continue;
    if (result.size >= 64)
      throw new Error("Too many generated receiver geometries.");
    const asset = await awaitBakeRuntimeRead(signal, () =>
      readAsset(reference.assetGuid, signal),
    );
    signal?.throwIfAborted();
    if (!asset) throw new Error("Generated receiver geometry is unavailable.");
    const geometry = await decodeBakedGeometryAsset(
      asset.bytes,
      asset.readBlob &&
        ((hash) => awaitBakeRuntimeRead(signal, () => asset.readBlob!(hash))),
    );
    signal?.throwIfAborted();
    if (
      geometry.guid !== reference.assetGuid ||
      geometry.manifest.contentHash !== reference.contentHash ||
      geometry.manifest.sceneGuid !== sceneGuid ||
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
