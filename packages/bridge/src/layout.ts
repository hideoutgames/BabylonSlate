/** Snapshot Float32Array layout — locked in docs/architecture/bridge.md */

export const SNAPSHOT_HEADER_FLOATS = 16;
export const SNAPSHOT_ACTOR_STRIDE = 16;
export const SNAPSHOT_LAYOUT_VERSION = 1;

/** ASCII "BSNP" as big-endian u32, reinterpreted as f32 bits. */
export const SNAPSHOT_MAGIC_U32 = 0x42534e50;

export const SNAPSHOT_MAGIC_F32 = (() => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, SNAPSHOT_MAGIC_U32, false);
  return new DataView(buf).getFloat32(0, false);
})();

export function actorSlotOffset(slotIndex: number): number {
  return SNAPSHOT_HEADER_FLOATS + slotIndex * SNAPSHOT_ACTOR_STRIDE;
}

export function snapshotFloatCount(maxActors: number): number {
  return SNAPSHOT_HEADER_FLOATS + maxActors * SNAPSHOT_ACTOR_STRIDE;
}

export function floatBitsToU32(f: number): number {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setFloat32(0, f, true);
  return view.getUint32(0, true);
}

export function u32ToFloatBits(u: number): number {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint32(0, u >>> 0, true);
  return view.getFloat32(0, true);
}
