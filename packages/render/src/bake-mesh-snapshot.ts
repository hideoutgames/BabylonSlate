import { Mesh, VertexBuffer } from "@babylonjs/core";
import type {
  BakeGeometrySource,
  BakeVertexAttribute,
} from "@babylonslate/core";
import { snapshotBakeGeometry } from "@babylonslate/assets";

const formats = new Map<number, [BakeVertexAttribute["componentType"], number]>(
  [
    [VertexBuffer.BYTE, ["i8", 1]],
    [VertexBuffer.UNSIGNED_BYTE, ["u8", 1]],
    [VertexBuffer.SHORT, ["i16", 2]],
    [VertexBuffer.UNSIGNED_SHORT, ["u16", 2]],
    [VertexBuffer.UNSIGNED_INT, ["u32", 4]],
    [VertexBuffer.FLOAT, ["f32", 4]],
  ],
);

/** Copy every packed attribute, retaining integer/normalized bytes across interleaved buffers. */
export function snapshotBakeMesh(mesh: Mesh): BakeGeometrySource {
  if (
    mesh.isDisposed() ||
    !mesh.geometry ||
    mesh.skeleton ||
    mesh.morphTargetManager ||
    mesh.hasThinInstances ||
    mesh.animations.length
  )
    throw new Error(
      "Bake geometry must be a realized static mesh without skinning, morphs or instances.",
    );
  const vertexCount = mesh.getTotalVertices();
  const indices = mesh.getIndices();
  if (
    !indices ||
    indices.length < 3 ||
    indices.length > 1536 ||
    vertexCount < 3 ||
    vertexCount > 49152
  )
    throw new Error(
      "Bake geometry exceeds the current 512-triangle provider limit or has no triangles.",
    );
  if (
    mesh.subMeshes.length !== 1 ||
    mesh.subMeshes[0].indexStart !== 0 ||
    mesh.subMeshes[0].indexCount !== indices.length
  )
    throw new Error(
      "Bake geometry needs one complete, identified source primitive.",
    );
  const attributes: BakeVertexAttribute[] = [];
  let bytes = 0;
  const kinds = mesh.getVerticesDataKinds();
  if (kinds.length > 64)
    throw new Error("Bake geometry has too many vertex attributes.");
  for (const name of kinds) {
    const buffer = mesh.getVertexBuffer(name)!;
    const format = formats.get(buffer.type);
    if (!format || buffer.getIsInstanced())
      throw new Error(`Bake attribute ${name} has an unsupported format.`);
    const components = buffer.getSize();
    const length = components * format[1];
    bytes += vertexCount * length;
    if (components < 1 || components > 16 || bytes > 32 * 1024 * 1024)
      throw new Error(
        "Bake vertex attributes exceed the admitted memory limit.",
      );
    const raw = buffer.getData();
    if (!raw)
      throw new Error(`Bake attribute ${name} has no readable source buffer.`);
    if (Array.isArray(raw) && buffer.type !== VertexBuffer.FLOAT)
      throw new Error(`Bake attribute ${name} needs a typed source buffer.`);
    const data = Array.isArray(raw) ? new Float32Array(raw) : raw;
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (
      buffer.byteOffset + (vertexCount - 1) * buffer.byteStride + length >
      source.byteLength
    )
      throw new Error(`Bake attribute ${name} is truncated.`);
    const packed = new Uint8Array(vertexCount * length);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const offset = buffer.byteOffset + vertex * buffer.byteStride;
      packed.set(source.subarray(offset, offset + length), vertex * length);
    }
    attributes.push({
      name,
      components,
      componentType: format[0],
      normalized: buffer.normalized,
      data: packed,
    });
  }
  return snapshotBakeGeometry({
    vertexCount,
    indices: new Uint32Array(indices),
    attributes,
  });
}
