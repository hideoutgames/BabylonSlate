import { beforeAll, describe, expect, it, vi } from "vitest";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { extractAnimationRootMotion } from "./animation-root-motion";
import { readGltfTriangles } from "./glb-geometry";
import { gltfGeometryDecodersReady } from "./gltf-geometry-decoders";
import { ImportLimitError } from "./import-limits";
import { encodeGlbJsonBin } from "./importers/glb-parse";
import { cookComplexCollision } from "./mesh-collision";
import { bytesOf, meshoptBoxGlb, meshoptFixtureGlb, type MeshoptFixtureCompression } from "./test-support/meshopt-gltf";

const FLOAT = 5126, UNSIGNED_BYTE = 5121, SHORT = 5122, UNSIGNED_INT = 5125;
const MESHOPT = "EXT_meshopt_compression";

beforeAll(async () => {
  await Promise.all([gltfGeometryDecodersReady(), MeshoptEncoder.ready]);
});

function cooked(source: Uint8Array) {
  const { mesh, problem } = cookComplexCollision(source, null);
  return { positions: mesh && Array.from(mesh.positions), indices: mesh && Array.from(mesh.indices), problem };
}

/**
 * {@link cooked} with each triangle started at its lowest index. The TRIANGLES codec keeps every triangle, their
 * order and their winding but may start a triangle at another of its corners, which is the same triangle.
 */
function cookedTriangles(source: Uint8Array) {
  const result = cooked(source);
  const indices = result.indices && result.indices.flatMap((_, at, all) => {
    if (at % 3 !== 0) return [];
    const triangle = all.slice(at, at + 3);
    const first = triangle.indexOf(Math.min(...triangle));
    return [triangle[first]!, triangle[(first + 1) % 3]!, triangle[(first + 2) % 3]!];
  });
  return { ...result, indices };
}

/** The fixture uncompressed and as `compression` stores it. */
async function twins(json: Record<string, unknown>, views: Parameters<typeof meshoptFixtureGlb>[1], compression: MeshoptFixtureCompression = "required") {
  return { plain: await meshoptFixtureGlb(json, views, "none"), compressed: await meshoptFixtureGlb(json, views, compression) };
}

// Every compressed fixture below cooks exactly its uncompressed twin's triangles: the vertex and index codecs are
// lossless, and the one lossy filter used for geometry (EXPONENTIAL) is given values it represents exactly.
describe("EXT_meshopt_compression geometry", () => {
  it.each(["required", "optional-with-fallback"] as const)(
    "cooks float positions (no filter) and TRIANGLES indices, %s, exactly as the uncompressed file", async (compression) => {
      const plain = await meshoptBoxGlb("none", 2);
      expect(cooked(plain)).toEqual({
        positions: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
        indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2],
        problem: null,
      });
      expect(cookedTriangles(await meshoptBoxGlb(compression, 2))).toEqual(cookedTriangles(plain));
    });

  it("dequantizes normalized int16 positions padded to 8 bytes and reads INDICES-mode uint32 indices", async () => {
    // KHR_mesh_quantization: normalized shorts in [-1, 1], scaled by 2 and moved by -1 along X by the node.
    const positions = new Int16Array([0, 0, 0, 0, 32767, 0, 0, 0, 0, 32767, 0, 0, 0, 0, -32767, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const { plain, compressed } = await twins({
      extensionsUsed: ["KHR_mesh_quantization"], extensionsRequired: ["KHR_mesh_quantization"],
      accessors: [
        { bufferView: 0, componentType: SHORT, normalized: true, count: 4, type: "VEC3", min: [0, 0, -32767], max: [32767, 32767, 0] },
        { bufferView: 1, componentType: UNSIGNED_INT, count: 6, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0, translation: [-1, 0, 0], scale: [2, 2, 2] }], scenes: [{ nodes: [0] }], scene: 0,
    }, [
      { bytes: bytesOf(positions), count: 4, byteStride: 8, mode: "ATTRIBUTES", vertex: true },
      { bytes: bytesOf(indices), count: 6, byteStride: 4, mode: "INDICES" },
    ]);
    expect(cooked(plain)).toEqual({ positions: [-1, 0, 0, 1, 0, 0, -1, 2, 0, -1, 0, -2], indices: [0, 1, 2, 0, 2, 3], problem: null });
    expect(cooked(compressed)).toEqual(cooked(plain));
  });

  it("decodes EXPONENTIAL-filtered positions", async () => {
    // A separate exponent per component and a 24-bit mantissa hold these dyadic values exactly, so the filter is
    // lossless here; a lossy encoding would show as a mismatch, not pass within a tolerance.
    const positions = new Float32Array([0.5, -1.25, 3, 1, 2, -0.75, -2, 0.25, 0]);
    const { plain, compressed } = await twins({
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3", min: [-2, -1.25, -0.75], max: [1, 2, 3] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    }, [{
      bytes: bytesOf(positions), count: 3, byteStride: 12, mode: "ATTRIBUTES", vertex: true, filter: "EXPONENTIAL",
      filtered: MeshoptEncoder.encodeFilterExp(positions, 3, 12, 24, "Separate"),
    }]);
    expect(cooked(plain)).toEqual({ positions: [0.5, -1.25, 3, 1, 2, -0.75, -2, 0.25, 0], indices: [0, 1, 2], problem: null });
    expect(cooked(compressed)).toEqual(cooked(plain));
  });

  it("reads positions interleaved in a 16-byte stride and decodes a view once however many primitives read it", async () => {
    // xyz floats then an RGBA8 colour per vertex; two nodes draw the same mesh.
    const vertices = new ArrayBuffer(48);
    const floats = new Float32Array(vertices);
    const colours = new Uint8Array(vertices);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((xyz, vertex) => {
      floats.set(xyz, vertex * 4);
      colours.set([255, 128, 0, 255], vertex * 16 + 12);
    });
    const { plain, compressed } = await twins({
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 0, byteOffset: 12, componentType: UNSIGNED_BYTE, normalized: true, count: 3, type: "VEC4" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [0, 0, 5] }], scenes: [{ nodes: [0, 1] }], scene: 0,
    }, [{ bytes: new Uint8Array(vertices), count: 3, byteStride: 16, mode: "ATTRIBUTES", vertex: true }]);
    expect(cooked(plain)).toEqual({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 5, 1, 0, 5, 0, 1, 5], indices: [0, 1, 2, 3, 4, 5], problem: null });
    const decode = vi.spyOn(MeshoptDecoder, "decodeGltfBuffer");
    try {
      expect(cooked(compressed)).toEqual(cooked(plain));
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("reads an optional extension's uncompressed fallback without decoding the compressed stream", async () => {
    // The streams are corrupt, so cooking the box proves the fallback bytes were read.
    const h = 0.5;
    const positions = new Float32Array([-h, 0, 0, h, 0, 0, 0, h, 0]);
    const fallback = await meshoptFixtureGlb({
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3", min: [-h, 0, 0], max: [h, h, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    }, [{ bytes: bytesOf(positions), count: 3, byteStride: 12, mode: "ATTRIBUTES", vertex: true }], "optional-with-fallback", { corrupt: true });
    expect(cooked(fallback)).toEqual({ positions: [-0.5, 0, 0, 0.5, 0, 0, 0, 0.5, 0], indices: [0, 1, 2], problem: null });
  });

  /** A required meshopt triangle whose extension (or file) `change` edits. */
  async function edited(change: (json: Record<string, unknown>, extension: Record<string, unknown>) => void, options: { corrupt?: boolean } = {}) {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const source = await meshoptFixtureGlb({
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    }, [{ bytes: bytesOf(positions), count: 3, byteStride: 12, mode: "ATTRIBUTES", vertex: true }], "required", options);
    const length = new DataView(source.buffer, source.byteOffset).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + length))) as Record<string, unknown>;
    const binLength = new DataView(source.buffer, source.byteOffset).getUint32(20 + length, true);
    const bin = source.subarray(28 + length, 28 + length + binLength);
    change(json, ((json.bufferViews as Record<string, unknown>[])[0]!.extensions as Record<string, Record<string, unknown>>)[MESHOPT]!);
    return encodeGlbJsonBin(json, bin);
  }

  it.each([
    ["a stream the decoder rejects", () => edited(() => {}, { corrupt: true }), /malformed: .*cannot be decoded/],
    ["a mode the extension does not define", () => edited((_json, extension) => { extension.mode = "STRIPS"; }), /malformed: .*mode STRIPS/],
    ["a filter the stride cannot hold", () => edited((_json, extension) => { extension.filter = "QUATERNION"; }), /malformed: .*filter QUATERNION/],
    ["a stride the codec cannot take", () => edited((_json, extension) => { extension.byteStride = 6; }), /malformed: .*byteStride of 6/],
    ["a stream outside the binary chunk", () => edited((_json, extension) => { extension.byteOffset = 4096; }), /malformed: .*past the end/],
    ["a stream in another buffer", () => edited((_json, extension) => { extension.buffer = 1; }), /malformed: .*reads buffer 1/],
    ["an accessor longer than its decoded view", () => edited((json) => { (json.accessors as Record<string, unknown>[])[0]!.count = 4; }), /malformed: .*run past the end/],
    ["KHR_meshopt_compression", () => edited((json) => {
      const view = (json.bufferViews as Record<string, Record<string, unknown>>[])[0]!;
      view.extensions = { KHR_meshopt_compression: view.extensions![MESHOPT] };
      json.extensionsUsed = json.extensionsRequired = ["KHR_meshopt_compression"];
    }), /KHR_meshopt_compression, which collision cooking cannot decode/],
  ] as const)("refuses %s with a reason instead of cooking or throwing", async (_name, build, problem) => {
    const result = cooked(await build());
    expect(result.positions).toBeNull();
    expect(result.problem).toMatch(problem);
  });

  it("fails the read by name when the decoded data would exceed the import limit, before decoding it", async () => {
    // 2^28 elements of 4 bytes decode to 1 GiB, plus the 12 the positions already took.
    const source = await edited((json, extension) => {
      (json.bufferViews as unknown[]).push({ buffer: 1, byteLength: 4, extensions: { [MESHOPT]: { ...extension, byteStride: 4, count: 2 ** 28 } } });
      (json.accessors as unknown[]).push({ bufferView: 1, componentType: UNSIGNED_INT, count: 3, type: "SCALAR" });
      (json.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!.indices = 1;
    });
    const decode = vi.spyOn(MeshoptDecoder, "decodeGltfBuffer");
    try {
      expect(() => readGltfTriangles(source, 1)).toThrow(ImportLimitError);
      expect(() => readGltfTriangles(source, 1)).toThrow(/meshopt-compressed buffer views decode to is 1024\.0 MiB; the import limit is 1,024 MiB/);
      // Only the positions decoded; the oversized view was refused before its allocation.
      expect(decode).toHaveBeenCalledTimes(2);
    } finally {
      decode.mockRestore();
    }
  });
});

describe("EXT_meshopt_compression animation keys", () => {
  /** A bone named hips turning a quarter turn about Y over one second, its rotation keys as `rotation` stores them. */
  async function turningBone(compressed: boolean) {
    const times = new Float32Array([0, 1]);
    const s = Math.SQRT1_2;
    const quaternions = new Float32Array([0, 0, 0, 1, 0, s, 0, s]);
    const json = {
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 2, type: "SCALAR", min: [0], max: [1] },
        compressed
          ? { bufferView: 1, componentType: SHORT, normalized: true, count: 2, type: "VEC4" }
          : { bufferView: 1, componentType: FLOAT, count: 2, type: "VEC4" },
      ],
      nodes: [{ name: "hips" }], scenes: [{ nodes: [0] }], scene: 0,
      animations: [{ name: "Turn", samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }],
    };
    const timeView = { bytes: bytesOf(times), count: 2, byteStride: 4, mode: "ATTRIBUTES" } as const;
    if (!compressed) return meshoptFixtureGlb(json, [timeView, { bytes: bytesOf(quaternions), count: 2, byteStride: 16, mode: "ATTRIBUTES" }], "none");
    const filtered = MeshoptEncoder.encodeFilterQuat(quaternions, 2, 8, 16);
    return meshoptFixtureGlb(json, [timeView, { bytes: filtered, filtered, count: 2, byteStride: 8, mode: "ATTRIBUTES", filter: "QUATERNION" }], "required");
  }

  it("samples root motion from QUATERNION-filtered rotation keys as from the float keys", async () => {
    const plain = extractAnimationRootMotion(await turningBone(false), "Turn", "hips")!;
    const compressed = extractAnimationRootMotion(await turningBone(true), "Turn", "hips")!;
    // The engine mirrors glTF's X, so a quarter turn about +Y reads as -90 degrees.
    expect(plain.track.yaw.at(-1)).toBe(-90);
    expect(compressed.track.x).toEqual(plain.track.x);
    expect(compressed.track.z).toEqual(plain.track.z);
    expect(compressed.track.yaw).toHaveLength(plain.track.yaw.length);
    // The filter keeps 16 bits per component and the keys are read back as normalized shorts, each off by at most
    // about 2^-15; a turn of 2·asin(2^-15·√3) is under 0.01 degrees.
    compressed.track.yaw.forEach((yaw, index) => expect(Math.abs(yaw - plain.track.yaw[index]!)).toBeLessThan(0.01));
  });
});
