import type {
  BakeGeometrySource,
  BakeVertexAttribute,
  GeneratedBakeTopology,
} from "@babylonslate/core";
import { sha256Hex, stableStringify } from "./bytes";

/** Below the pinned xatlasjs UInt16 boundary even after every triangle corner splits. */
export const BAKE_GEOMETRY_MAX_INDICES = 49152;
export const BAKE_GEOMETRY_MAX_VERTICES = 49152;
export const BAKE_GEOMETRY_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const sizes = { i8: 1, u8: 1, i16: 2, u16: 2, u32: 4, f32: 4 } as const;

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}.`);
}

/** Copies before the first await so caller edits cannot change a prepared job. */
export function snapshotBakeGeometry(
  source: BakeGeometrySource,
): BakeGeometrySource {
  integer(
    source.vertexCount,
    3,
    BAKE_GEOMETRY_MAX_VERTICES,
    "source vertex count",
  );
  if (!(source.indices instanceof Uint32Array))
    throw new Error("Bake indices must be Uint32Array.");
  integer(
    source.indices.length,
    3,
    BAKE_GEOMETRY_MAX_INDICES,
    "triangle index count",
  );
  if (
    source.indices.length % 3 ||
    source.indices.some((index) => index >= source.vertexCount)
  )
    throw new Error("Invalid bake triangle indices.");
  integer(source.attributes.length, 1, 64, "vertex attribute count");
  const names = new Set<string>();
  let total = source.indices.byteLength;
  const attributes = source.attributes.map((attribute) => {
    if (
      !attribute.name ||
      attribute.name.length > 128 ||
      names.has(attribute.name)
    )
      throw new Error("Invalid or duplicate vertex attribute name.");
    names.add(attribute.name);
    const size = sizes[attribute.componentType];
    integer(attribute.components, 1, 16, "vertex attribute components");
    if (
      !size ||
      typeof attribute.normalized !== "boolean" ||
      !(attribute.data instanceof Uint8Array) ||
      attribute.data.byteLength !==
        source.vertexCount * attribute.components * size
    )
      throw new Error("Invalid packed vertex attribute.");
    total += attribute.data.byteLength;
    if (total > BAKE_GEOMETRY_MAX_SOURCE_BYTES)
      throw new Error("Bake geometry exceeds its source byte limit.");
    return { ...attribute, data: attribute.data.slice() };
  });
  return {
    vertexCount: source.vertexCount,
    indices: source.indices.slice(),
    attributes,
  };
}

/** Includes every source attribute and its exact bytes, including integer/normalized custom data. */
export async function fingerprintBakeGeometry(
  source: BakeGeometrySource,
): Promise<string> {
  const owned = snapshotBakeGeometry(source);
  const indexBytes = new Uint8Array(owned.indices.length * 4);
  const indexView = new DataView(indexBytes.buffer);
  owned.indices.forEach((value, index) =>
    indexView.setUint32(index * 4, value, true),
  );
  const attributes = await Promise.all(
    [...owned.attributes]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(async (attribute) => ({
        name: attribute.name,
        componentType: attribute.componentType,
        components: attribute.components,
        normalized: attribute.normalized,
        sha256: await sha256Hex(attribute.data),
      })),
  );
  return sha256Hex(
    new TextEncoder().encode(
      stableStringify({
        version: 1,
        vertexCount: owned.vertexCount,
        indices: await sha256Hex(indexBytes),
        attributes,
      }),
    ),
  );
}

export function validateBakeTopology(
  topology: GeneratedBakeTopology,
  sourceVertexCount: number,
  indexCount: number,
): void {
  if (
    !(topology.indices instanceof Uint32Array) ||
    !(topology.originalVertices instanceof Uint32Array) ||
    !(topology.uv2 instanceof Float32Array)
  )
    throw new Error("Invalid generated bake topology arrays.");
  integer(
    sourceVertexCount,
    3,
    BAKE_GEOMETRY_MAX_VERTICES,
    "source vertex count",
  );
  integer(indexCount, 3, BAKE_GEOMETRY_MAX_INDICES, "triangle index count");
  integer(
    topology.originalVertices.length,
    3,
    BAKE_GEOMETRY_MAX_VERTICES,
    "generated vertex count",
  );
  if (
    indexCount % 3 ||
    topology.indices.length !== indexCount ||
    topology.uv2.length !== topology.originalVertices.length * 2 ||
    topology.originalVertices.some((index) => index >= sourceVertexCount) ||
    topology.indices.some(
      (index) => index >= topology.originalVertices.length,
    ) ||
    topology.uv2.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    throw new Error("Invalid generated bake topology range or length.");
}

/** Preserves exact component bytes and metadata; only the binding's UV2 channel is replaced. */
export function remapBakeGeometry(
  source: BakeGeometrySource,
  topology: GeneratedBakeTopology,
): BakeGeometrySource {
  const owned = snapshotBakeGeometry(source);
  validateBakeTopology(topology, owned.vertexCount, owned.indices.length);
  if (
    topology.indices.some(
      (index, corner) =>
        topology.originalVertices[index] !== owned.indices[corner],
    )
  )
    throw new Error(
      "Generated topology changed authored triangle order or winding.",
    );
  const strideTotal = owned.attributes
    .filter((attribute) => attribute.name !== "uv2")
    .reduce(
      (bytes, attribute) =>
        bytes + attribute.components * sizes[attribute.componentType],
      8,
    );
  if (
    strideTotal * topology.originalVertices.length +
      topology.indices.byteLength >
    BAKE_GEOMETRY_MAX_SOURCE_BYTES
  )
    throw new Error(
      "Generated vertex attributes exceed the output byte limit.",
    );
  const attributes: BakeVertexAttribute[] = owned.attributes
    .filter((attribute) => attribute.name !== "uv2")
    .map((attribute) => {
      const stride = attribute.components * sizes[attribute.componentType];
      const data = new Uint8Array(topology.originalVertices.length * stride);
      topology.originalVertices.forEach((original, index) =>
        data.set(
          attribute.data.subarray(original * stride, (original + 1) * stride),
          index * stride,
        ),
      );
      return { ...attribute, data };
    });
  const uv2 = new Uint8Array(topology.uv2.length * 4);
  const view = new DataView(uv2.buffer);
  topology.uv2.forEach((value, index) =>
    view.setFloat32(index * 4, value, true),
  );
  attributes.push({
    name: "uv2",
    componentType: "f32",
    components: 2,
    normalized: false,
    data: uv2,
  });
  return {
    vertexCount: topology.originalVertices.length,
    indices: topology.indices.slice(),
    attributes,
  };
}
