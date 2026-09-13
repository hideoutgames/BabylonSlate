import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";

/** Repair the bundled unlit model for the lit template, preserving its shape,
 * UVs and hierarchy. This preparation never changes general model imports.
 */
export function prepareMannequinNormals(bytes: Uint8Array): Uint8Array {
  const split = splitGlbJsonBin(bytes);
  if (!split) throw new Error("Invalid bundled Mannequin GLB");
  type Accessor = { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string };
  type BufferView = { buffer?: number; byteOffset?: number; byteStride?: number; byteLength: number };
  type Primitive = { attributes: Record<string, number>; indices?: number };
  const accessors = split.json.accessors as Accessor[];
  const views = split.json.bufferViews as BufferView[];
  const data = new DataView(split.bin.buffer, split.bin.byteOffset, split.bin.byteLength);
  const chunks = [split.bin];
  let byteLength = split.bin.byteLength;
  const offset = (accessor: Accessor, index: number, size: number) => {
    const view = views[accessor.bufferView]!;
    return (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? size);
  };
  const append = (values: Float32Array, source: Accessor, count: number) => {
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(new Uint8Array(padding)); byteLength += padding; }
    const bufferView = views.length;
    views.push({ buffer: 0, byteOffset: byteLength, byteLength: values.byteLength });
    chunks.push(new Uint8Array(values.buffer));
    byteLength += values.byteLength;
    accessors.push({ ...source, bufferView, byteOffset: 0, count });
    return accessors.length - 1;
  };
  for (const mesh of split.json.meshes as { primitives: Primitive[] }[]) {
    for (const primitive of mesh.primitives) {
      const indices = accessors[primitive.indices!]!;
      const indexSize = indices.componentType === 5125 ? 4 : indices.componentType === 5123 ? 2 : 1;
      const vertices = Array.from({ length: indices.count }, (_, i) => {
        const at = offset(indices, i, indexSize);
        return indexSize === 4 ? data.getUint32(at, true) : indexSize === 2 ? data.getUint16(at, true) : data.getUint8(at);
      });
      let positions: Float32Array | undefined;
      // This bundled static hierarchy uses float position/UV attributes only.
      // Separate triangle corners so the head's shared edge vertices can also
      // have a face normal without altering positions or triangle winding.
      delete primitive.attributes.TANGENT;
      const normalAccessor = accessors[primitive.attributes.NORMAL!]!;
      delete primitive.attributes.NORMAL;
      for (const [name, index] of Object.entries(primitive.attributes)) {
        const source = accessors[index]!;
        if (source.componentType !== 5126 || !["VEC2", "VEC3"].includes(source.type))
          throw new Error("Unsupported bundled Mannequin vertex format");
        const size = source.type === "VEC2" ? 2 : 3;
        const values = new Float32Array(vertices.length * size);
        vertices.forEach((vertex, i) => {
          for (let axis = 0; axis < size; axis++)
            values[i * size + axis] = data.getFloat32(offset(source, vertex, size * 4) + axis * 4, true);
        });
        primitive.attributes[name] = append(values, source, vertices.length);
        if (name === "POSITION") positions = values;
      }
      const normals = new Float32Array(vertices.length * 3);
      for (let i = 0; i < vertices.length * 3; i += 9) {
        const p = positions!;
        const ux = p[i + 3]! - p[i]!, uy = p[i + 4]! - p[i + 1]!, uz = p[i + 5]! - p[i + 2]!;
        const vx = p[i + 6]! - p[i]!, vy = p[i + 7]! - p[i + 1]!, vz = p[i + 8]! - p[i + 2]!;
        const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const length = Math.hypot(...normal);
        for (let corner = 0; corner < 3; corner++)
          for (let axis = 0; axis < 3; axis++) normals[i + corner * 3 + axis] = normal[axis]! / length;
      }
      primitive.attributes.NORMAL = append(normals, normalAccessor, vertices.length);
      delete primitive.indices;
    }
  }
  const bin = new Uint8Array(byteLength);
  let cursor = 0;
  for (const chunk of chunks) { bin.set(chunk, cursor); cursor += chunk.byteLength; }
  (split.json.buffers as { byteLength: number }[])[0]!.byteLength = byteLength;
  return encodeGlbJsonBin(split.json, bin);
}
