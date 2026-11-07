import { readActorSlotInto, type ActorSlot } from "../snapshot-buffer";

/** One actor slot decoded into a new object: the allocating form of `readActorSlotInto`, for tests. */
export function readActorSlot(buf: Float32Array, slotIndex: number): ActorSlot {
  return readActorSlotInto(buf, slotIndex, {
    slotId: 0,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 0 },
    scale: { x: 0, y: 0, z: 0 },
    flags: 0,
  });
}
