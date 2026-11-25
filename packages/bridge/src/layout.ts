/** Snapshot Float32Array layout — locked in .agents/reference/architecture/bridge.md */

export const SNAPSHOT_HEADER_FLOATS = 16;
export const SNAPSHOT_ACTOR_STRIDE = 16;
export const SNAPSHOT_LAYOUT_VERSION = 2;
/** Two uint32 metadata words after the actor rows: `[publishSerial, dirtyFlags]`. */
export const SNAPSHOT_DIRTY_META_WORDS = 2;
/** Dirty-tail flag bit 0: publisher wrote the dirty-row bitset for this frame. */
export const SNAPSHOT_DIRTY_FLAG_TRACKED = 1;
/** Dirty-tail flag bit 1: layout, origin, or capacity changed; reader must full-reconcile. */
export const SNAPSHOT_DIRTY_FLAG_FULL = 2;

/** ASCII "HPNP" as big-endian u32, reinterpreted as f32 bits. */
export const SNAPSHOT_MAGIC_U32 = 0x48504e50;

export const SNAPSHOT_MAGIC_F32 = (() => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, SNAPSHOT_MAGIC_U32, false);
  return new DataView(buf).getFloat32(0, false);
})();

export function actorSlotOffset(slotIndex: number): number {
  return SNAPSHOT_HEADER_FLOATS + slotIndex * SNAPSHOT_ACTOR_STRIDE;
}

/** Number of uint32 bitset words needed to track `maxActors` rows (1 bit per row). */
export function snapshotDirtyBitsetWords(maxActors: number): number {
  return maxActors > 0 ? Math.ceil(maxActors / 32) : 0;
}

/** Float/u32 word index where the dirty metadata + bitset tail starts for a buffer of `maxActors`. */
export function snapshotDirtyMetaOffset(maxActors: number): number {
  return SNAPSHOT_HEADER_FLOATS + maxActors * SNAPSHOT_ACTOR_STRIDE;
}

export function snapshotFloatCount(maxActors: number): number {
  if (maxActors <= 0) return SNAPSHOT_HEADER_FLOATS;
  return (
    SNAPSHOT_HEADER_FLOATS +
    maxActors * SNAPSHOT_ACTOR_STRIDE +
    SNAPSHOT_DIRTY_META_WORDS +
    snapshotDirtyBitsetWords(maxActors)
  );
}

const bitsScratch = new DataView(new ArrayBuffer(4));

export function floatBitsToU32(f: number): number {
  bitsScratch.setFloat32(0, f, true);
  return bitsScratch.getUint32(0, true);
}

export function u32ToFloatBits(u: number): number {
  bitsScratch.setUint32(0, u >>> 0, true);
  return bitsScratch.getFloat32(0, true);
}
