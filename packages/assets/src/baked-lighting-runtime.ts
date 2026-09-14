import type {
  BakeInputHashes,
  BakedLightingValidity,
} from "@babylonslate/core";
import {
  bakedLightingValidity,
  decodeBakedLightingAsset,
  type DecodedBakedLighting,
} from "./baked-lighting";
import { loadBakedGeometryArtifacts } from "./baked-geometry-store";
import type { DecodedBakedGeometry } from "./baked-geometry";
import { awaitBakeRuntimeRead } from "./bake-runtime-read";

/** Complete exported containers or an editor container with its owning blob reader. */
export interface BakeRuntimeAsset {
  bytes: Uint8Array;
  readBlob?: (hash: string) => Promise<Uint8Array>;
}
export type BakeRuntimeAssetReader = (
  guid: string,
  signal?: AbortSignal,
) => Promise<BakeRuntimeAsset | undefined>;

export type LoadedRuntimeBake =
  | { validity: Exclude<BakedLightingValidity, { status: "valid" }> }
  | {
      validity: { status: "valid" };
      lighting: DecodedBakedLighting;
      geometries: ReadonlyMap<string, DecodedBakedGeometry>;
    };

/** No authoring provider, registry or Babylon dependency is needed to reopen a bake. */
export async function loadRuntimeBake(options: {
  assetGuid?: string;
  sceneGuid: string;
  inputs: BakeInputHashes;
  readAsset: BakeRuntimeAssetReader;
  signal?: AbortSignal;
}): Promise<LoadedRuntimeBake> {
  const { assetGuid, sceneGuid, readAsset, signal } = options;
  const inputs = { ...options.inputs };
  signal?.throwIfAborted();
  if (!assetGuid)
    return {
      validity: { status: "missing", reason: "No baked lighting is assigned." },
    };
  try {
    const source = await awaitBakeRuntimeRead(signal, () =>
      readAsset(assetGuid, signal),
    );
    signal?.throwIfAborted();
    if (!source)
      return {
        validity: {
          status: "missing",
          reason: "The assigned baked lighting asset is unavailable.",
        },
      };
    const lighting = await decodeBakedLightingAsset(
      source.bytes,
      source.readBlob &&
        ((hash) => awaitBakeRuntimeRead(signal, () => source.readBlob!(hash))),
    );
    signal?.throwIfAborted();
    if (lighting.guid !== assetGuid)
      throw new Error(
        "Baked lighting asset identity differs from its reference.",
      );
    const validity = bakedLightingValidity(
      sceneGuid,
      inputs,
      lighting.manifest,
    );
    if (validity.status !== "valid") return { validity };
    const geometries = await loadBakedGeometryArtifacts(
      readAsset,
      lighting.manifest,
      signal,
    );
    signal?.throwIfAborted();
    return { validity, lighting, geometries };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      validity: {
        status: "missing",
        reason:
          error instanceof Error
            ? error.message
            : "Baked lighting could not be read.",
      },
    };
  }
}
