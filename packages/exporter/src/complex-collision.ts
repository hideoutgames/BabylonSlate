import type { CollisionTriangleMesh } from "@haptic/core";

/**
 * A Model's Complex Collision triangles, cooked at export (`HPCC` sidecar): the game loads them instead of parsing the
 * GLB and cooking at runtime. Layout, little-endian:
 *
 *     "HPCC"  u16 version  u16 index bytes (2 or 4)  u32 position floats  u32 indices
 *     f32[position floats]  u16|u32[indices]
 *
 * The header is 16 bytes, so both arrays start 4-byte aligned and decode as views of the file's buffer.
 */
export const COMPLEX_COLLISION_EXPORT_TYPE = "ComplexCollision";
const COMPLEX_COLLISION_EXPORT_GUID_PREFIX = "complex-collision:";
const MAGIC = [0x48, 0x50, 0x43, 0x43]; // HPCC
const VERSION = 1;
const HEADER_BYTES = 16;

export function complexCollisionExportGuid(modelGuid: string): string {
  return `${COMPLEX_COLLISION_EXPORT_GUID_PREFIX}${modelGuid}`;
}

export function modelGuidFromComplexCollisionExport(guid: string): string | null {
  return guid.startsWith(COMPLEX_COLLISION_EXPORT_GUID_PREFIX) ? guid.slice(COMPLEX_COLLISION_EXPORT_GUID_PREFIX.length) : null;
}

export function encodeComplexCollisionMesh(mesh: CollisionTriangleMesh): Uint8Array {
  const indexBytes = mesh.indices.BYTES_PER_ELEMENT;
  const positionsBytes = mesh.positions.byteLength;
  const out = new Uint8Array(HEADER_BYTES + positionsBytes + mesh.indices.byteLength);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, indexBytes, true);
  view.setUint32(8, mesh.positions.length, true);
  view.setUint32(12, mesh.indices.length, true);
  for (let i = 0; i < mesh.positions.length; i++) view.setFloat32(HEADER_BYTES + i * 4, mesh.positions[i]!, true);
  const indicesAt = HEADER_BYTES + positionsBytes;
  for (let i = 0; i < mesh.indices.length; i++) {
    if (indexBytes === 2) view.setUint16(indicesAt + i * 2, mesh.indices[i]!, true);
    else view.setUint32(indicesAt + i * 4, mesh.indices[i]!, true);
  }
  return out;
}

/** The mesh an `HPCC` sidecar holds; throws on anything else. Little-endian hosts get views of `bytes`. */
export function decodeComplexCollisionMesh(bytes: Uint8Array): CollisionTriangleMesh {
  if (bytes.byteLength < HEADER_BYTES || MAGIC.some((value, index) => bytes[index] !== value)) throw new Error("Not a Complex Collision sidecar.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`Unsupported Complex Collision sidecar version ${version}; rebuild the game.`);
  const indexBytes = view.getUint16(6, true);
  const positionCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const indicesAt = HEADER_BYTES + positionCount * 4;
  if ((indexBytes !== 2 && indexBytes !== 4) || indicesAt + indexCount * indexBytes > bytes.byteLength) throw new Error("Corrupt Complex Collision sidecar.");
  const aligned = (bytes.byteOffset & 3) === 0 && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (aligned) {
    return {
      positions: new Float32Array(bytes.buffer, bytes.byteOffset + HEADER_BYTES, positionCount),
      indices: indexBytes === 2
        ? new Uint16Array(bytes.buffer, bytes.byteOffset + indicesAt, indexCount)
        : new Uint32Array(bytes.buffer, bytes.byteOffset + indicesAt, indexCount),
    };
  }
  const positions = new Float32Array(positionCount);
  for (let i = 0; i < positionCount; i++) positions[i] = view.getFloat32(HEADER_BYTES + i * 4, true);
  const indices = indexBytes === 2 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = indexBytes === 2 ? view.getUint16(indicesAt + i * 2, true) : view.getUint32(indicesAt + i * 4, true);
  return { positions, indices };
}
