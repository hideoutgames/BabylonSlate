import { proxy, releaseProxy, wrap, type Remote } from "comlink";
import xatlasWorkerSource from "xatlasjs/dist/xatlas.js?raw";
import xatlasWasmUrl from "xatlasjs/dist/xatlas.wasm?url&inline";
import xatlasLicense from "xatlasjs/LICENSE?raw";
import comlinkLicense from "comlink/LICENSE?raw";
import type {
  BakeGeometrySource,
  GeneratedBakeTopology,
} from "@babylonslate/core";
import {
  fingerprintBakeGeometry,
  remapBakeGeometry,
  snapshotBakeGeometry,
} from "@babylonslate/assets";

export interface BakeUvProgress {
  phase: "loading" | "adding" | "unwrapping" | "validating";
  progress: number;
}
export interface BakeUvResult {
  sourceHash: string;
  topology: GeneratedBakeTopology;
  width: number;
  height: number;
  paddingTexels: number;
  provider: { id: "xatlasjs"; version: "0.2.0"; adapterVersion: "1" };
}
interface AtlasOutput {
  width: number;
  height: number;
  atlasCount: number;
  meshes: Array<{
    index: Uint16Array;
    oldIndexes: Uint16Array;
    vertex: { coords1: Float32Array };
    vertexCount: number;
  }>;
}
interface XAtlasApi {
  loaded: boolean;
  createAtlas(): void;
  addMesh(indices: Uint16Array, positions: Float32Array): object | null;
  generateAtlas(chartOptions: object, packOptions: object): AtlasOutput;
  destroyAtlas(): void;
}
type XAtlasConstructor = new (
  onLoad: () => void,
  locateFile: () => string,
  progress: (phase: number, value: number) => void,
) => XAtlasApi;
let active = false;

function abortError(): Error {
  return new DOMException("UV generation was cancelled.", "AbortError");
}

/** One disposable authoring Worker; its bundled WASM never uses a CDN or a viewport Engine. */
export async function unwrapBakeGeometry(
  source: BakeGeometrySource,
  options: {
    resolution: number;
    paddingTexels: number;
    signal?: AbortSignal;
    onProgress?: (progress: BakeUvProgress) => void;
  },
): Promise<BakeUvResult> {
  const { resolution, paddingTexels, signal, onProgress } = options;
  if (active) throw new Error("A UV generation job is already active.");
  if (signal?.aborted) throw abortError();
  if (
    !Number.isInteger(resolution) ||
    resolution < 16 ||
    resolution > 2048 ||
    !Number.isInteger(paddingTexels) ||
    paddingTexels < 1 ||
    paddingTexels > 16 ||
    paddingTexels * 2 >= resolution
  )
    throw new Error("Unsupported UV resolution or padding.");
  const owned = snapshotBakeGeometry(source);
  const position = owned.attributes.find(
    (attribute) => attribute.name === "position",
  );
  if (
    !position ||
    position.componentType !== "f32" ||
    position.components !== 3 ||
    position.normalized
  )
    throw new Error("UV generation requires packed float32 positions.");
  const positions = new Float32Array(owned.vertexCount * 3);
  const view = new DataView(
    position.data.buffer,
    position.data.byteOffset,
    position.data.byteLength,
  );
  for (let index = 0; index < positions.length; index++)
    positions[index] = view.getFloat32(index * 4, true);
  if (
    positions.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e6)
  )
    throw new Error("UV source positions are invalid.");
  let surfaceArea = 0;
  for (let corner = 0; corner < owned.indices.length; corner += 3) {
    const a = owned.indices[corner] * 3;
    const b = owned.indices[corner + 1] * 3;
    const c = owned.indices[corner + 2] * 3;
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const acX = positions[c] - positions[a];
    const acY = positions[c + 1] - positions[a + 1];
    const acZ = positions[c + 2] - positions[a + 2];
    surfaceArea +=
      Math.hypot(
        abY * acZ - abZ * acY,
        abZ * acX - abX * acZ,
        abX * acY - abY * acX,
      ) / 2;
  }
  if (surfaceArea <= 1e-12)
    throw new Error("UV source has no usable triangle area.");
  active = true;
  const resources: {
    worker?: Worker;
    workerUrl?: string;
    remote?: Remote<XAtlasConstructor>;
    api?: Remote<XAtlasApi>;
  } = {};
  let settled = false;
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // All failures are observed even if a synchronous progress callback throws first.
  void failed.catch(() => {});
  const abort = () => fail(abortError());
  const ensureCurrent = () => {
    if (settled || signal?.aborted) throw abortError();
  };
  const timer = setTimeout(
    () => fail(new Error("UV generation exceeded its two-minute deadline.")),
    120_000,
  );
  const progress = (phase: BakeUvProgress["phase"], value: number) => {
    if (!settled)
      onProgress?.({
        phase,
        progress: Math.max(0, Math.min(1, value)),
      });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      failed,
      (async () => {
        progress("loading", 0);
        const sourceHash = await fingerprintBakeGeometry(owned);
        ensureCurrent();
        resources.workerUrl = URL.createObjectURL(
          new Blob(
            [
              `/*\n${xatlasLicense}\n${comlinkLicense}\n*/\n`,
              xatlasWorkerSource,
            ],
            { type: "text/javascript" },
          ),
        );
        const worker = (resources.worker = new Worker(resources.workerUrl, {
          name: "Baked Lighting UV Generation",
        }));
        worker.onerror = (event) =>
          fail(new Error(`UV worker failed: ${event.message}`));
        worker.onmessageerror = () =>
          fail(new Error("UV worker returned an unreadable response."));
        const remote = (resources.remote = wrap<XAtlasConstructor>(worker));
        let ready!: () => void;
        const initialized = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const api = (resources.api = await new remote(
          proxy(() => ready()),
          proxy(() => xatlasWasmUrl),
          proxy((_phase: number, value: number) => {
            try {
              progress("unwrapping", value / 100);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          }),
        ));
        ensureCurrent();
        await initialized;
        ensureCurrent();
        progress("adding", 0);
        await api.createAtlas();
        ensureCurrent();
        if (!(await api.addMesh(new Uint16Array(owned.indices), positions)))
          throw new Error("xatlas rejected the source geometry.");
        ensureCurrent();
        progress("unwrapping", 0);
        // Native resolution is only an estimate unless density is explicit. Lower
        // source-space density to admit one fixed-size atlas; never reduce padding.
        let texelsPerUnit =
          Math.max(1, resolution - 2 * paddingTexels - 2) / Math.sqrt(surfaceArea);
        let result!: AtlasOutput;
        for (let attempt = 0; attempt < 4; attempt++) {
          result = await api.generateAtlas(
            { maxIterations: 1 },
            {
              resolution,
              texelsPerUnit,
              padding: paddingTexels,
              bilinear: true,
              bruteForce: false,
            },
          );
          ensureCurrent();
          if (
            result.atlasCount === 1 &&
            result.width <= resolution &&
            result.height <= resolution
          )
            break;
          texelsPerUnit /= 2;
        }
        progress("validating", 0);
        const mesh = result.meshes[0];
        if (
          result.atlasCount !== 1 ||
          result.meshes.length !== 1 ||
          !mesh ||
          !Number.isInteger(result.width) ||
          !Number.isInteger(result.height) ||
          result.width < 1 ||
          result.height < 1 ||
          result.width > resolution ||
          result.height > resolution
        )
          throw new Error(
            `UV output ${result.width}×${result.height} (${result.atlasCount} atlases) exceeds the admitted single ${resolution}×${resolution} atlas.`,
          );
        const topology = {
          indices: new Uint32Array(mesh.index),
          originalVertices: new Uint32Array(mesh.oldIndexes),
          uv2: mesh.vertex.coords1.slice(),
        };
        // Exact winding/triangle and every-attribute validation before exposing provider output.
        remapBakeGeometry(owned, topology);
        await api.destroyAtlas();
        ensureCurrent();
        progress("validating", 1);
        return {
          sourceHash,
          topology,
          width: result.width,
          height: result.height,
          paddingTexels: paddingTexels,
          provider: {
            id: "xatlasjs" as const,
            version: "0.2.0" as const,
            adapterVersion: "1" as const,
          },
        };
      })(),
    ]);
  } finally {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    // Termination also releases synchronous native work and its entire WASM heap on failure/abort.
    resources.api?.[releaseProxy]();
    resources.remote?.[releaseProxy]();
    if (resources.worker) {
      resources.worker.onerror = null;
      resources.worker.onmessageerror = null;
      resources.worker.terminate();
    }
    if (resources.workerUrl) URL.revokeObjectURL(resources.workerUrl);
    active = false;
  }
}
