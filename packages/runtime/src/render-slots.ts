import type { Actor } from "@babylonslate/object-model";
import type { RuntimeSubsystems } from "./runtime-subsystems";

interface RenderSlotsHost {
  /** Grow the snapshot buffer to hold `required` slots, or throw. */
  ensureCapacity(required: number): void;
  /** The live actor with this guid (`World.findActor`). */
  findActor(guid: string): Actor | undefined;
}

/**
 * Render slot table: which actor owns each snapshot slot. Released slots are
 * reused last-released first, then new ids grow from 0, so ids stay
 * deterministic for traces and the snapshot layout. Slots belong to actor
 * objects, so a stale reference to a departed actor never reaches the slot of
 * a successor that reuses its guid.
 */
export class RenderSlots {
  private readonly owners = new Map<number, Actor>();
  /** Each actor's own slot. */
  private readonly byActor = new WeakMap<Actor, number>();
  private readonly free: number[] = [];
  private nextUnused = 0;
  private readonly subsystems: RuntimeSubsystems;
  private readonly host: RenderSlotsHost;

  constructor(subsystems: RuntimeSubsystems, host: RenderSlotsHost) {
    this.subsystems = subsystems;
    this.host = host;
  }

  /** Give the actor a slot; the caller announces it (`spawn`). */
  allocate(actor: Actor): number {
    const slotId = this.free.pop() ?? this.nextUnused;
    this.host.ensureCapacity(slotId + 1);
    if (slotId === this.nextUnused) this.nextUnused += 1;
    this.owners.set(slotId, actor);
    this.byActor.set(actor, slotId);
    return slotId;
  }

  /**
   * Run every subsystem's `releaseSlot` hook while the table still names the
   * owner, then forget the slot and return it to the free list.
   */
  release(slotId: number): void {
    const owner = this.owners.get(slotId);
    this.subsystems.releaseSlot(slotId, owner);
    if (owner && this.byActor.get(owner) === slotId) this.byActor.delete(owner);
    this.owners.delete(slotId);
    this.free.push(slotId);
  }

  /** The render slot this actor's own commands target. */
  actorSlot(actor: Actor): number | undefined {
    const slot = this.byActor.get(actor);
    return slot !== undefined && this.owners.get(slot) === actor ? slot : undefined;
  }

  /** The slot recorded for this actor, without checking it still owns it. */
  recordedSlot(actor: Actor): number | undefined {
    return this.byActor.get(actor);
  }

  /** The slot of the live actor with this guid. */
  guidSlot(guid: string): number | undefined {
    const actor = this.host.findActor(guid);
    return actor ? this.actorSlot(actor) : undefined;
  }

  owner(slotId: number): Actor | undefined {
    return this.owners.get(slotId);
  }

  /** Slots in use (stats `liveActors`). */
  get size(): number {
    return this.owners.size;
  }

  /** Live `[slot, owner]` entries in allocation order; releasing while iterating is safe. */
  entries(): IterableIterator<[number, Actor]> {
    return this.owners.entries();
  }
}
