export const TEXTURE_BYTE_CEILING = 2 * 1024 * 1024 * 1024;
export const TEXTURE_BYTE_CEILING_MIN = 256 * 1024 * 1024;
export const TEXTURE_BYTE_CEILING_MAX = 8 * 1024 * 1024 * 1024;
export const TEXTURE_EVICTION_TARGET_FACTOR = 0.8;
/** Documented iPad suggestion — not the runtime default. */
export const IPAD_TEXTURE_BYTE_SUGGESTION = 512 * 1024 * 1024;
export const GEOMETRY_BYTE_CEILING = 128 * 1024 * 1024;
export const DRAW_CALL_WARN_CEILING = 400;

const VERTEX_STRIDE_BYTES = 32;

export function accountedGeometryBytes(
  vertexCount: number,
  indexCount: number,
): number {
  return vertexCount * VERTEX_STRIDE_BYTES + indexCount * Uint32Array.BYTES_PER_ELEMENT;
}

export function textureByteCeilingWarning(bytes: number): string | null {
  if (bytes <= TEXTURE_BYTE_CEILING) return null;
  return `Accounted texture bytes ${bytes} exceed the ${TEXTURE_BYTE_CEILING} ceiling.`;
}

export function geometryByteCeilingWarning(bytes: number): string | null {
  if (bytes <= GEOMETRY_BYTE_CEILING) return null;
  return `Accounted geometry bytes ${bytes} exceed the ${GEOMETRY_BYTE_CEILING} ceiling.`;
}

export function drawCallCeilingWarning(draws: number): string | null {
  if (draws <= DRAW_CALL_WARN_CEILING) return null;
  return `Draw calls ${draws} exceed the warning ceiling of ${DRAW_CALL_WARN_CEILING}.`;
}
