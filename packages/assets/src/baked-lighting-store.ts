import type {
  BakeInputHashes,
  BakedLightingManifest,
  BakedLightingValidity,
} from "@babylonslate/core";
import {
  bakedLightingImportResult,
  bakedLightingValidity,
  decodeBakedLightingAsset,
  parseBakedLightingManifest,
  type DecodedBakedLighting,
} from "./baked-lighting";
import { newAssetGuid } from "./guid";
import type { AssetRegistry } from "./registry";
import { loadBakedGeometryBindings, StaleBakedGeometryError } from "./baked-geometry-store";

/** The document owner increments generation on replacement, cancellation or a new job. */
export interface BakePublicationOwner {
  sceneGuid: string;
  generation: number;
  inputs: BakeInputHashes;
}

export type BakePublicationResult =
  | { status: "published"; guid: string }
  | {
      status: "refused";
      reason: "aborted" | "stale" | "not-accepted";
      candidateGuid: string | null;
    };

/**
 * Writes a new immutable candidate before changing any Scene reference. The synchronous
 * owner callback must replace the reference only when it accepts this expected generation.
 * Refused candidates may remain on disk: ProjectStorage has no transactional rename/CAS.
 */
export async function publishBakedLighting(options: {
  registry: AssetRegistry;
  rootId: string;
  name: string;
  manifest: BakedLightingManifest;
  atlases: ReadonlyMap<string, Uint8Array>;
  current: () => BakePublicationOwner;
  commit: (guid: string, expected: BakePublicationOwner) => boolean;
  signal?: AbortSignal;
}): Promise<BakePublicationResult> {
  const expected = structuredClone(options.current());
  const manifest = parseBakedLightingManifest(options.manifest);
  const guid = newAssetGuid();
  const candidate = await bakedLightingImportResult({
    guid,
    name: options.name,
    manifest,
    atlases: options.atlases,
  });
  const refusal = (): "aborted" | "stale" | null => {
    if (options.signal?.aborted) return "aborted";
    const current = options.current();
    if (
      bakedLightingValidity(expected.sceneGuid, expected.inputs, manifest)
        .status !== "valid" ||
      current.generation !== expected.generation ||
      current.sceneGuid !== expected.sceneGuid ||
      bakedLightingValidity(current.sceneGuid, current.inputs, manifest)
        .status !== "valid"
    )
      return "stale";
    return null;
  };
  const before = refusal();
  if (before) return { status: "refused", reason: before, candidateGuid: null };
  for (const dependency of manifest.dependencies) {
    const asset = options.registry.getByGuid(dependency);
    if (!asset || asset.placeholder)
      throw new Error(
        `Baked lighting input asset ${dependency} is unavailable.`,
      );
  }
  await loadBakedGeometryBindings(options.registry, manifest);
  const afterGeometry = refusal();
  if (afterGeometry) return { status: "refused", reason: afterGeometry, candidateGuid: null };
  await options.registry.createAsset(
    options.rootId,
    `BakedLighting/${guid}.babasset`,
    candidate,
  );
  const after = refusal();
  if (after) return { status: "refused", reason: after, candidateGuid: guid };
  if (
    manifest.dependencies.some((dependency) => {
      const asset = options.registry.getByGuid(dependency);
      return !asset || asset.placeholder;
    })
  )
    return { status: "refused", reason: "stale", candidateGuid: guid };
  // No await between the ownership check and this synchronous publication.
  if (!options.commit(guid, expected))
    return { status: "refused", reason: "not-accepted", candidateGuid: guid };
  return { status: "published", guid };
}

/** Reopening never drops a saved reference merely because the output is missing or stale. */
export async function loadBakedLightingReference(options: {
  registry: AssetRegistry;
  guid: string | null | undefined;
  sceneGuid: string;
  inputs: BakeInputHashes;
}): Promise<{
  referenceGuid: string | null;
  validity: BakedLightingValidity;
  /** Retained validated data may be stale; only `valid` is eligible for current receiver binding. */
  retained: DecodedBakedLighting | null;
}> {
  const referenceGuid = options.guid ?? null;
  const inputs = { ...options.inputs };
  const sceneGuid = options.sceneGuid;
  const missing = (reason: string) => ({
    referenceGuid,
    validity: { status: "missing" as const, reason },
    retained: null,
  });
  const asset = referenceGuid
    ? options.registry.getByGuid(referenceGuid)
    : undefined;
  if (!asset || asset.placeholder)
    return missing("The assigned baked lighting asset is unavailable.");
  try {
    const bytes = await options.registry
      .storageFor(asset.rootId)
      .readBinary(asset.path);
    const retained = await decodeBakedLightingAsset(bytes, (sha256) =>
      options.registry.blobsFor(asset.rootId).readBlob(sha256),
    );
    if (retained.guid !== referenceGuid)
      return missing("Baked lighting asset identity changed.");
    for (const dependency of retained.manifest.dependencies) {
      const input = options.registry.getByGuid(dependency);
      if (!input || input.placeholder)
        return {
          referenceGuid,
          retained,
          validity: {
            status: "missing",
            reason: `Baked lighting input asset ${dependency} is unavailable.`,
          },
        };
    }
    try {
      await loadBakedGeometryBindings(options.registry, retained.manifest);
    } catch (error) {
      return { referenceGuid, retained, validity: error instanceof StaleBakedGeometryError
        ? { status: "stale", reasons: [error.message] }
        : { status: "missing", reason: error instanceof Error ? error.message : String(error) } };
    }
    return {
      referenceGuid,
      retained,
      validity: bakedLightingValidity(sceneGuid, inputs, retained.manifest),
    };
  } catch (error) {
    return missing(error instanceof Error ? error.message : String(error));
  }
}
