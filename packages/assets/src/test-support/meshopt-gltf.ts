import { MeshoptEncoder } from "meshoptimizer/encoder";
import { encodeGlbJsonBin } from "../importers/glb-parse";

const MESHOPT = "EXT_meshopt_compression";

/** One buffer view of a fixture: its uncompressed bytes and how `EXT_meshopt_compression` stores them. */
export interface MeshoptFixtureView {
  /** The view's uncompressed bytes: what the twin (or the fallback) stores. */
  bytes: Uint8Array;
  count: number;
  byteStride: number;
  mode: "ATTRIBUTES" | "TRIANGLES" | "INDICES";
  filter?: "NONE" | "OCTAHEDRAL" | "QUATERNION" | "EXPONENTIAL";
  /** A filter's encoded output, compressed in place of `bytes` (`MeshoptEncoder.encodeFilter*`). */
  filtered?: Uint8Array;
  /** A vertex attribute view: its bufferView declares `byteStride`. */
  vertex?: boolean;
}

/**
 * How a fixture stores its views: `none`, the uncompressed twin; `required`, meshopt only, with an empty fallback
 * buffer as gltfpack writes it; `optional-with-fallback`, meshopt listed as optional and the uncompressed bytes kept
 * in the binary chunk beside the compressed streams.
 */
export type MeshoptFixtureCompression = "none" | "required" | "optional-with-fallback";

/** The parts end to end, each padded to four bytes, and where each starts. */
function layout(parts: readonly Uint8Array[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let size = 0;
  for (const part of parts) {
    offsets.push(size);
    size += Math.ceil(part.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(size);
  parts.forEach((part, index) => bin.set(part, offsets[index]!));
  return { bin, offsets };
}

/** A typed array's bytes. */
export function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/**
 * A GLB whose buffer views are `views` (bufferView i is views[i]) stored as `compression` says; `json` holds the rest
 * (accessors, meshes, nodes, scenes, animations). `corrupt` overwrites every compressed stream with bytes no meshopt
 * codec accepts.
 */
export async function meshoptFixtureGlb(
  json: Record<string, unknown>,
  views: readonly MeshoptFixtureView[],
  compression: MeshoptFixtureCompression,
  options: { corrupt?: boolean } = {},
): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const plain = layout(views.map((view) => view.bytes));
  const bufferViews = views.map((view, index) => ({
    buffer: 0, byteOffset: plain.offsets[index]!, byteLength: view.bytes.byteLength,
    ...(view.vertex ? { byteStride: view.byteStride } : {}),
  }));
  const base = { asset: { version: "2.0", generator: "haptic-test" }, ...json };
  if (compression === "none") return encodeGlbJsonBin({ ...base, buffers: [{ byteLength: plain.bin.byteLength }], bufferViews }, plain.bin);
  const streams = views.map((view) => {
    const stream = MeshoptEncoder.encodeGltfBuffer(view.filtered ?? view.bytes, view.count, view.byteStride, view.mode);
    return options.corrupt ? stream.fill(0xab) : stream;
  });
  const fallback = compression === "optional-with-fallback";
  const packed = layout(fallback ? [...views.map((view) => view.bytes), ...streams] : streams);
  const streamAt = fallback ? views.length : 0;
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  return encodeGlbJsonBin({
    ...base,
    extensionsUsed: [...used, MESHOPT],
    ...(fallback ? {} : { extensionsRequired: [...required, MESHOPT] }),
    buffers: fallback
      ? [{ byteLength: packed.bin.byteLength }]
      : [{ byteLength: packed.bin.byteLength }, { byteLength: plain.bin.byteLength, extensions: { [MESHOPT]: { fallback: true } } }],
    bufferViews: bufferViews.map((bufferView, index) => {
      const view = views[index]!;
      return {
        ...bufferView, buffer: fallback ? 0 : 1,
        extensions: { [MESHOPT]: {
          buffer: 0, byteOffset: packed.offsets[streamAt + index]!, byteLength: streams[index]!.byteLength,
          byteStride: view.byteStride, count: view.count, mode: view.mode,
          ...(view.filter && view.filter !== "NONE" ? { filter: view.filter } : {}),
        } },
      };
    }),
  }, packed.bin);
}

/** {@link meshoptFixtureGlb} of a centred cube `size` across: float positions and uint16 TRIANGLES indices. */
export function meshoptBoxGlb(compression: MeshoptFixtureCompression, size = 1): Promise<Uint8Array> {
  const h = size / 2;
  const positions = new Float32Array([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return meshoptFixtureGlb({
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-h, -h, -h], max: [h, h, h] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }, [
    { bytes: bytesOf(positions), count: 8, byteStride: 12, mode: "ATTRIBUTES", vertex: true },
    { bytes: bytesOf(indices), count: indices.length, byteStride: 2, mode: "TRIANGLES" },
  ], compression);
}
