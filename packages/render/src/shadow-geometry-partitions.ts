import { Mesh, SubMesh, type AbstractMesh } from "@babylonjs/core";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";

/** Partition static index ranges without copying geometry or reordering faces. */
export function partitionShadowGeometry(mesh: AbstractMesh): void {
  if (
    !(mesh instanceof Mesh) ||
    hasDeformingShadowBounds(mesh) ||
    mesh.hasThinInstances ||
    mesh.instances.length
  )
    return;
  const vertexData = mesh.getVerticesData("position");
  if (
    !vertexData ||
    mesh.isVerticesDataPresent("matricesIndices") ||
    mesh.getTotalIndices() < 12_288
  )
    return;
  const box = mesh.getBoundingInfo().boundingBox;
  if (box.maximumWorld.subtract(box.minimumWorld).lengthSquared() < 64 * 64)
    return;
  const ranges = mesh.subMeshes.map((part) => ({
    material: part.materialIndex,
    start: part.indexStart,
    count: part.indexCount,
    verticesStart: part.verticesStart,
    verticesCount: part.verticesCount,
  }));
  if (!ranges.some((range) => range.count > 3072)) return;
  mesh.releaseSubMeshes();
  for (const range of ranges) {
    for (
      let start = range.start;
      start < range.start + range.count;
      start += 3072
    ) {
      new SubMesh(
        range.material,
        range.verticesStart,
        range.verticesCount,
        start,
        Math.min(3072, range.start + range.count - start),
        mesh,
      );
    }
  }
}
