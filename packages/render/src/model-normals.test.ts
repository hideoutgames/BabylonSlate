import { describe, expect, it } from "vitest";
import { Mesh, VertexBuffer } from "@babylonjs/core";
import { encodeGlbJsonBin } from "@haptic/assets";
import { createTestEngine } from "./create-null-engine";
import { loadModelContainer } from "./model-container";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const TRIANGLE_FAN = 6;

/** Two triangles folded along an edge, so each face has its own normal. */
const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 1]];
const triangles = [0, 1, 2, 0, 2, 3];
const faceNormals = [[0, 0, 1], [1, -1, 1].map((value) => value / Math.sqrt(3))];

/**
 * A skinned fold: unindexed (six vertices, as glTF files without an index
 * accessor) or indexed (four shared vertices), with or without authored
 * normals. Vertex k binds to joint k % 2 of the source corner it copies.
 */
function foldedSkinGlb(options: { indexed: boolean; normals?: boolean; mode?: number }): Uint8Array {
  const order = options.indexed ? [0, 1, 2, 3] : triangles;
  const count = order.length;
  const arrays: ArrayBufferView[] = [Float32Array.from(order.flatMap((corner) => corners[corner]!))];
  if (options.normals) arrays.push(Float32Array.from(order.flatMap((_, vertex) => faceNormals[vertex < 3 ? 0 : 1]!)));
  arrays.push(Uint8Array.from(order.flatMap((corner) => [corner % 2, 0, 0, 0])));
  arrays.push(Float32Array.from(order.flatMap(() => [1, 0, 0, 0])));
  if (options.indexed) arrays.push(Uint16Array.from(triangles));
  const bin = new Uint8Array(arrays.reduce((total, array) => total + array.byteLength, 0));
  const bufferViews = [];
  let offset = 0;
  for (const array of arrays) {
    bin.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength });
    offset += array.byteLength;
  }
  const accessors: Record<string, unknown>[] = [];
  const attribute = (componentType: number, type: string, extra: Record<string, unknown> = {}) => {
    accessors.push({ bufferView: accessors.length, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const attributes: Record<string, number> = {
    POSITION: attribute(FLOAT, "VEC3", { min: [0, 0, 0], max: [1, 1, 1] }),
  };
  if (options.normals) attributes.NORMAL = attribute(FLOAT, "VEC3");
  attributes.JOINTS_0 = attribute(UNSIGNED_BYTE, "VEC4");
  attributes.WEIGHTS_0 = attribute(FLOAT, "VEC4");
  const primitive: Record<string, unknown> = { attributes };
  if (options.mode !== undefined) primitive.mode = options.mode;
  if (options.indexed) {
    primitive.indices = accessors.length;
    accessors.push({ bufferView: accessors.length, componentType: UNSIGNED_SHORT, count: triangles.length, type: "SCALAR" });
  }
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, skin: 0 }, { children: [2] }, {}],
      skins: [{ joints: [1, 2] }],
      meshes: [{ primitives: [primitive] }],
      accessors,
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

async function loadedMesh(bytes: Uint8Array) {
  const handle = createTestEngine();
  const container = await loadModelContainer(handle.scene, bytes, "fold.glb");
  const mesh = container.meshes.find((entry): entry is Mesh => entry instanceof Mesh && entry.getTotalVertices() > 0);
  if (!mesh) throw new Error("The fixture must load a mesh");
  return {
    mesh,
    dispose: () => {
      container.dispose();
      handle.scene.dispose();
      handle.engine.dispose();
    },
  };
}

const read = (mesh: Mesh, kind: string) => Array.from(mesh.getVerticesData(kind) ?? []);
const approximately = (values: number[]) => values.map((value) => expect.closeTo(value, 5));

/**
 * Surface Materials read the normal attribute, and a missing buffer reads as
 * zero, which lights nothing: a glTF without NORMAL (the Khronos Fox) drew black.
 */
describe("models without normals", () => {
  it("flat shades an unindexed skinned mesh like its authored-normal twin", async () => {
    const authored = await loadedMesh(foldedSkinGlb({ indexed: false, normals: true }));
    const generated = await loadedMesh(foldedSkinGlb({ indexed: false }));
    try {
      expect(generated.mesh.getTotalVertices()).toBe(6);
      expect(read(generated.mesh, VertexBuffer.NormalKind)).toEqual(approximately(read(authored.mesh, VertexBuffer.NormalKind)));
      expect(read(generated.mesh, VertexBuffer.MatricesWeightsKind)).toEqual(read(authored.mesh, VertexBuffer.MatricesWeightsKind));
    } finally {
      authored.dispose();
      generated.dispose();
    }
  });

  it("unfolds an indexed skinned mesh into faces without detaching joints from their vertices", async () => {
    const authored = await loadedMesh(foldedSkinGlb({ indexed: false, normals: true }));
    const generated = await loadedMesh(foldedSkinGlb({ indexed: true }));
    try {
      // Three vertices per face in index order, with every stream unfolded the same way.
      expect(generated.mesh.getTotalVertices()).toBe(6);
      expect(read(generated.mesh, VertexBuffer.PositionKind)).toEqual(read(authored.mesh, VertexBuffer.PositionKind));
      expect(read(generated.mesh, VertexBuffer.NormalKind)).toEqual(approximately(read(authored.mesh, VertexBuffer.NormalKind)));
      expect(read(generated.mesh, VertexBuffer.MatricesIndicesKind)).toEqual(read(authored.mesh, VertexBuffer.MatricesIndicesKind));
      expect(read(generated.mesh, VertexBuffer.MatricesWeightsKind)).toEqual(read(authored.mesh, VertexBuffer.MatricesWeightsKind));
      expect(generated.mesh.skeleton).toBeTruthy();
    } finally {
      authored.dispose();
      generated.dispose();
    }
  });

  it("keeps authored normals and shared vertices", async () => {
    const authored = await loadedMesh(foldedSkinGlb({ indexed: true, normals: true }));
    try {
      expect(authored.mesh.getTotalVertices()).toBe(4);
      expect(authored.mesh.getTotalIndices()).toBe(6);
      expect(read(authored.mesh, VertexBuffer.NormalKind).slice(0, 3)).toEqual([0, 0, 1]);
    } finally {
      authored.dispose();
    }
  });

  it("leaves non-triangle primitives without normals", async () => {
    const fan = await loadedMesh(foldedSkinGlb({ indexed: false, mode: TRIANGLE_FAN }));
    try {
      expect(fan.mesh.isVerticesDataPresent(VertexBuffer.NormalKind)).toBe(false);
    } finally {
      fan.dispose();
    }
  });
});
