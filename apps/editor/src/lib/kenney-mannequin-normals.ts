import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";

/** Repair the supplied unlit model's corner normals for the lit template.
 * Its faces already have separate vertices, so topology and UVs stay intact.
 * This is intentionally restricted to the bundled Mannequin, not imports.
 */
export function prepareMannequinNormals(bytes: Uint8Array): Uint8Array {
  const split = splitGlbJsonBin(bytes);
  if (!split) throw new Error("Invalid bundled Mannequin GLB");
  type Accessor = { bufferView: number; byteOffset?: number; count: number; componentType: number };
  type BufferView = { byteOffset?: number; byteStride?: number };
  type Primitive = { attributes: Record<string, number>; indices: number };
  const accessors = split.json.accessors as Accessor[];
  const views = split.json.bufferViews as BufferView[];
  const data = new DataView(split.bin.buffer, split.bin.byteOffset, split.bin.byteLength);
  const offset = (accessor: Accessor, index: number, size: number) => {
    const view = views[accessor.bufferView]!;
    return (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? size);
  };
  for (const mesh of split.json.meshes as { primitives: Primitive[] }[]) {
    for (const primitive of mesh.primitives) {
      const positions = accessors[primitive.attributes.POSITION!]!;
      const normals = accessors[primitive.attributes.NORMAL!]!;
      const indices = accessors[primitive.indices]!;
      const indexSize = indices.componentType === 5125 ? 4 : indices.componentType === 5123 ? 2 : 1;
      const indexAt = (i: number) => indexSize === 4
        ? data.getUint32(offset(indices, i, 4), true)
        : indexSize === 2 ? data.getUint16(offset(indices, i, 2), true) : data.getUint8(offset(indices, i, 1));
      const position = (i: number) => [0, 4, 8].map((axis) => data.getFloat32(offset(positions, i, 12) + axis, true));
      const sums = new Float64Array(normals.count * 3);
      for (let i = 0; i < indices.count; i += 3) {
        const triangle = [indexAt(i), indexAt(i + 1), indexAt(i + 2)];
        const [a, b, c] = triangle.map(position) as [number[], number[], number[]];
        const u = b.map((value, axis) => value - a[axis]!);
        const v = c.map((value, axis) => value - a[axis]!);
        const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        for (const vertex of triangle)
          for (let axis = 0; axis < 3; axis++) sums[vertex * 3 + axis]! += normal[axis]!;
      }
      for (let vertex = 0; vertex < normals.count; vertex++) {
        const normal = sums.subarray(vertex * 3, vertex * 3 + 3);
        const length = Math.hypot(...normal);
        if (length === 0) continue;
        for (let axis = 0; axis < 3; axis++)
          data.setFloat32(offset(normals, vertex, 12) + axis * 4, normal[axis]! / length, true);
      }
      // The template has no normal map. Let Babylon derive a tangent frame
      // from its corrected normals if a normal map is authored later.
      delete primitive.attributes.TANGENT;
    }
  }
  return encodeGlbJsonBin(split.json, split.bin);
}
