import type {
  BakedGeometryManifest,
  BakedLightingManifest,
} from "@babylonslate/core";
import {
  bakedGeometryImportResult,
  encodeBakeTopology,
  newAssetGuid,
  publishBakedLighting,
  sha256Hex,
  type AssetRegistry,
  type BakePublicationOwner,
} from "@babylonslate/assets";
import { unwrapBakeGeometry } from "./bake-uv-atlas";
import { bakeLightingPrototype } from "./bake-provider-prototype";
import { validateBakePrototypeInput } from "./bake-prototype-input";
import {
  preparedBakeReceiverTransport,
  StaleSceneBakeError,
  type PreparedSceneBake,
} from "./scene-bake-preparation";

export type SceneBakePhase =
  "preparing" | "unwrapping" | "building" | "compiling" | "baking" | "readback" | "assembling" | "writing";
export interface SceneBakeProgress {
  phase: SceneBakePhase;
  progress: number;
  receiver: number;
  receivers: number;
}
export interface SceneBakeJobAdapter {
  unwrap: typeof unwrapBakeGeometry;
  bake: typeof bakeLightingPrototype;
}

// Process-wide authoring ownership, independent of Babylon's viewport Engine ledger.
// A failed final context release quarantines this owner until the application reloads.
let activeJob = false;
let quarantined = false;
const MIB = 1024 * 1024;

/** Account managed typed buffers and provider estimates, not driver/context/native-heap memory. */
export function estimateSceneBakeJob(prepared: PreparedSceneBake) {
  const receivers = prepared.meshes.filter((mesh) => mesh.receiver);
  const sourceSizes = prepared.meshes.map(
    (mesh) =>
      mesh.source.indices.byteLength +
      mesh.source.attributes.reduce(
        (sum, attribute) => sum + attribute.data.byteLength,
        0,
      ),
  );
  const sourceBytes = sourceSizes.reduce((sum, bytes) => sum + bytes, 0);
  const transportBytes = prepared.meshes.reduce(
    (sum, mesh) => sum + mesh.transport.positions.byteLength,
    0,
  );
  const atlasBytes = prepared.settings.resolution ** 2 * 16 * receivers.length;
  // Full seam splitting: index + xref + UV2 for every triangle corner, including candidate copies.
  const topologyBytes = receivers.reduce(
    (sum, mesh) => sum + mesh.source.indices.length * 16,
    0,
  );
  const uvBytes =
    sourceBytes + Math.max(0, ...sourceSizes) * 3 + topologyBytes * 2;
  const publicationBytes = sourceBytes + atlasBytes * 5 + topologyBytes * 4;
  const providerBytes = Math.max(
    ...prepared.batches.map((batch) =>
      validateBakePrototypeInput({
        meshes: prepared.meshes.map((mesh) => mesh.transport),
        lights: batch.lights,
        size: prepared.settings.resolution,
        samples: prepared.settings.samples,
        bounces: prepared.settings.bounces,
        mode: batch.mode,
      }),
    ),
  );
  const peakManagedBytes = Math.max(
    uvBytes,
    publicationBytes,
    sourceBytes + transportBytes * 2 + atlasBytes * 2 + providerBytes,
  );
  if (
    !receivers.length ||
    receivers.length > 64 ||
    sourceBytes > 32 * MIB ||
    !Number.isFinite(providerBytes) ||
    providerBytes > 32 * MIB ||
    peakManagedBytes > 128 * MIB
  )
    throw new Error(
      "This bake exceeds the supported working-data budget. Reduce receivers, geometry or atlas resolution.",
    );
  return { sourceBytes, providerBytes, peakManagedBytes };
}

/** Nearest covered radiance extends into gutters; alpha still identifies the actual receiver. */
export function padBakeIrradiance(
  values: Float32Array,
  size: number,
  padding: number,
): void {
  const original = values.slice();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const target = (y * size + x) * 4;
      if (original[target + 3] !== 0) continue;
      let nearest = -1,
        distance = Infinity;
      for (let dy = -padding; dy <= padding; dy++)
        for (let dx = -padding; dx <= padding; dx++) {
          const px = x + dx,
            py = y + dy;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          const candidate = (py * size + px) * 4;
          const squared = dx * dx + dy * dy;
          if (original[candidate + 3] > 0 && squared < distance) {
            nearest = candidate;
            distance = squared;
          }
        }
      if (nearest >= 0)
        for (let channel = 0; channel < 3; channel++)
          values[target + channel] = original[nearest + channel];
    }
}

/** Explicit, serialized authoring work. Immutable candidates never replace the prior reference on refusal. */
export async function runSceneBakeJob(options: {
  prepare: (signal: AbortSignal) => Promise<PreparedSceneBake>;
  isCurrent: () => boolean;
  registry: AssetRegistry;
  rootId: string;
  name: string;
  commit: (guid: string, expected: BakePublicationOwner) => boolean;
  signal?: AbortSignal;
  onProgress?: (value: SceneBakeProgress) => void;
  /** Worker/GPU boundary only; production callers use the default adapter. */
  adapter?: SceneBakeJobAdapter;
}): Promise<{
  guid: string;
  manifest: BakedLightingManifest;
  estimatedManagedBytes: number;
}> {
  if (quarantined)
    throw new Error(
      "The previous bake could not release its graphics resources. Reopen the editor before baking again.",
    );
  if (activeJob)
    throw new Error("Another Bake Lighting job is still running or disposing.");
  activeJob = true;
  const abort = new AbortController();
  const cancel = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = setTimeout(
    () =>
      abort.abort(
        new Error("Bake Lighting exceeded its two-minute job limit."),
      ),
    120_000,
  );
  const check = () => {
    abort.signal.throwIfAborted();
    if (!options.isCurrent()) throw new StaleSceneBakeError();
  };
  let receiverIndex = 0,
    receiverCount = 0,
    reportedProgress = 0;
  const progress = (phase: SceneBakePhase, value: number) => {
    check();
    reportedProgress = Math.max(reportedProgress, value);
    options.onProgress?.({
      phase,
      progress: reportedProgress,
      receiver: receiverIndex,
      receivers: receiverCount,
    });
    check();
  };
  const adapter = options.adapter ?? {
    unwrap: unwrapBakeGeometry,
    bake: bakeLightingPrototype,
  };
  try {
    progress("preparing", 0);
    const prepared = await options.prepare(abort.signal);
    check();
    const estimate = estimateSceneBakeJob(prepared);
    const { resolution, paddingTexels, samples, bounces } = prepared.settings;
    const interior = resolution - paddingTexels * 2;
    if (interior < 16 || paddingTexels * 2 >= interior)
      throw new Error(
        "Use an atlas resolution of at least 32 pixels with room for its padding.",
      );
    const receivers = prepared.meshes.filter((mesh) => mesh.receiver);
    receiverCount = receivers.length;
    const manifest: BakedLightingManifest = {
      version: 1,
      sceneGuid: prepared.owner.sceneGuid,
      inputs: { ...prepared.inputs },
      provider: {
        id: "three-gpu-pathtracer",
        version: "0.0.24",
        adapterVersion: "scene-job-1",
      },
      settingsVersion: "scene-job-1",
      dependencies: [...prepared.dependencies],
      sources: structuredClone(prepared.sources),
      receivers: [],
      atlases: [],
    };
    const atlases = new Map<string, Uint8Array>();
    const geometryCandidates: Array<{
      guid: string;
      result: Awaited<ReturnType<typeof bakedGeometryImportResult>>;
    }> = [];
    for (const receiver of receivers) {
      receiverIndex++;
      const baseProgress = 5 + ((receiverIndex - 1) / receiverCount) * 80;
      progress("unwrapping", baseProgress);
      const uv = await adapter.unwrap(receiver.source, {
        resolution: interior,
        paddingTexels,
        signal: abort.signal,
        onProgress: (value) =>
          progress(
            "unwrapping",
            baseProgress + (value.progress * 15) / receiverCount,
          ),
      });
      check();
      if (
        uv.width !== interior ||
        uv.height !== interior ||
        uv.sourceHash !== receiver.hashes.geometry
      )
        throw new Error(
          "Generated UV coordinates do not match this receiver and atlas.",
        );
      const geometryGuid = newAssetGuid();
      const topologyBytes = encodeBakeTopology(
        uv.topology,
        receiver.source.vertexCount,
      );
      const geometryManifest: BakedGeometryManifest = {
        version: 1,
        sceneGuid: prepared.owner.sceneGuid,
        receiver: receiver.identity,
        sourceHash: receiver.hashes.geometry,
        sourceVertexCount: receiver.source.vertexCount,
        indexCount: uv.topology.indices.length,
        vertexCount: uv.topology.originalVertices.length,
        contentHash: await sha256Hex(topologyBytes),
        provider: uv.provider,
        layout: {
          width: interior,
          height: interior,
          paddingTexels,
          uvSet: 1,
          coordinates: "normalized-bottom-first",
          mipLevels: 1,
        },
      };
      check();
      geometryCandidates.push({
        guid: geometryGuid,
        result: await bakedGeometryImportResult({
          guid: geometryGuid,
          name: `${options.name} Receiver ${receiverIndex}`,
          manifest: geometryManifest,
          topology: uv.topology,
        }),
      });
      check();
      const transport = preparedBakeReceiverTransport(receiver, uv.topology);
      const scale = interior / resolution,
        offset = paddingTexels / resolution;
      for (let index = 0; index < transport.uv2!.length; index++)
        transport.uv2![index] = transport.uv2![index] * scale + offset;
      const sum = new Float32Array(resolution * resolution * 4);
      for (
        let batchIndex = 0;
        batchIndex < prepared.batches.length;
        batchIndex++
      ) {
        const batch = prepared.batches[batchIndex];
        let released = false;
        progress("building", baseProgress + 15 / receiverCount);
        let baked;
        try {
          baked = await adapter.bake(
            {
              meshes: prepared.meshes.map((mesh) =>
                mesh === receiver ? transport : mesh.transport,
              ),
              lights: batch.lights,
              size: resolution,
              samples,
              bounces,
              mode: batch.mode,
            },
            {
              signal: abort.signal,
              onDisposed: (value) => {
                released = value.contextReleased;
              },
              onProgress: (value) => {
                // Cancellation cannot interrupt disposal or turn its progress callback into a cleanup failure.
                if (value.phase !== "disposing")
                  progress(
                    value.phase === "sampling"
                      ? "baking"
                      : value.phase === "compiling"
                        ? "compiling"
                        : value.phase === "readback"
                          ? "readback"
                          : "building",
                    baseProgress +
                      (15 +
                        ((batchIndex +
                          value.samples / Math.max(1, value.totalSamples)) /
                          prepared.batches.length) *
                          60) /
                        receiverCount,
                  );
              },
            },
          );
        } finally {
          // Retain ownership even on failure until the provider confirms its private context is gone.
          if (!released) quarantined = true;
        }
        if (!released)
          throw new Error(
            "The bake could not release its graphics resources. The previous bake is retained.",
          );
        check();
        if (
          baked.size !== resolution ||
          baked.irradiance.length !== sum.length ||
          baked.coveredTexels < 1
        )
          throw new Error(
            "The bake provider returned an incomplete receiver atlas.",
          );
        for (let index = 0; index < sum.length; index++) {
          const value = baked.irradiance[index];
          if (!Number.isFinite(value) || value < 0)
            throw new Error("The bake provider returned invalid irradiance.");
          if (index % 4 === 3) {
            if (
              (value !== 0 && value !== 1) ||
              (batchIndex > 0 && sum[index] !== value)
            )
              throw new Error(
                "Bake source batches have inconsistent receiver coverage.",
              );
            sum[index] = value;
          } else sum[index] += value;
        }
      }
      progress("assembling", baseProgress + 78 / receiverCount);
      padBakeIrradiance(sum, resolution, paddingTexels);
      const bytes = new Uint8Array(sum.byteLength);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < sum.length; index++)
        view.setFloat32(index * 4, sum[index], true);
      const atlasGuid = newAssetGuid();
      manifest.atlases.push({
        guid: atlasGuid,
        chunkId: `atlas:${atlasGuid}`,
        width: resolution,
        height: resolution,
        sha256: await sha256Hex(bytes),
        encoding: "rgba32float-le",
        colorSpace: "linear",
        quantity: "diffuseIrradiance",
        convention: "physical-E",
        alpha: "coverage",
        rowOrder: "bottomFirst",
        uvSet: 1,
        mipLevels: 1,
        gutterTexels: paddingTexels,
      });
      check();
      atlases.set(atlasGuid, bytes);
      manifest.dependencies.push(geometryGuid);
      manifest.receivers.push({
        identity: receiver.identity,
        mobility: "static",
        hashes: { ...receiver.hashes },
        atlasGuid,
        generatedGeometry: {
          assetGuid: geometryGuid,
          contentHash: geometryManifest.contentHash,
        },
        scale: [scale, scale],
        offset: [offset, offset],
        contributions: prepared.sources.map((source) => ({
          sourceId: source.id,
          term:
            source.kind === "environment"
              ? "environmentDiffuse"
              : source.mobility === "static"
                ? "directAndIndirect"
                : "indirectOnly",
        })),
      });
    }
    progress("writing", 90);
    for (const candidate of geometryCandidates) {
      check();
      await options.registry.createAsset(
        options.rootId,
        `BakedGeometry/${candidate.guid}.babasset`,
        candidate.result,
      );
      check();
    }
    const expected: BakePublicationOwner = {
      ...prepared.owner,
      inputs: prepared.inputs,
    };
    const published = await publishBakedLighting({
      registry: options.registry,
      rootId: options.rootId,
      name: options.name,
      manifest,
      atlases,
      current: () =>
        options.isCurrent()
          ? expected
          : { ...expected, generation: expected.generation + 1 },
      signal: abort.signal,
      commit: (guid, owner) => {
        check();
        return options.commit(guid, owner);
      },
    });
    if (published.status !== "published") {
      check();
      throw new Error(
        "The Scene did not accept this bake. Its previous bake is retained.",
      );
    }
    // Publication changes the document identity; do not perform a stale check afterward.
    try {
      options.onProgress?.({
        phase: "writing",
        progress: 100,
        receiver: receiverIndex,
        receivers: receiverCount,
      });
    } catch {
      /* Observer failure cannot undo an already committed reference. */
    }
    return {
      guid: published.guid,
      manifest,
      estimatedManagedBytes: estimate.peakManagedBytes,
    };
  } catch (error) {
    // Providers may report generic AbortError; retain the authoring deadline's
    // actionable reason once cleanup has completed.
    if (
      abort.signal.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
    )
      throw abort.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    activeJob = false;
  }
}
