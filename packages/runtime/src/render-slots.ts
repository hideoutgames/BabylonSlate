import type { Actor } from "@babylonslate/object-model";
import type { RuntimeSubsystems } from "./runtime-subsystems";

interface RenderSlotsHost {
  /** Grow the snapshot buffer to hold `required` slots, or throw. */
  ensureCapacity(required: number): void;
  /** The guid's first-spawned live actor (`World.findActor`). */
  findActor(guid: string): Actor | undefined;
}

/**
 * Render slot table: which actor owns each snapshot slot. Released slots are
 * reused last-released first, then new ids grow from 0, so ids stay
 * deterministic for traces and the snapshot layout.
 */
export class RenderSlots {
  /** A guid's latest-assigned slot, in Map insertion order. */
  private readonly byGuid = new Map<string, number>();
  private readonly owners = new Map<number, Actor>();
  /** Each actor's own slot; `byGuid` holds a guid's latest-assigned one. */
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
    this.byGuid.set(actor.guid, slotId);
    this.owners.set(slotId, actor);
    this.byActor.set(actor, slotId);
    return slotId;
  }

  /**
   * Run every subsystem's `releaseSlot` hook while the table still names the
   * owner, then forget the slot and return it to the free list.
   */
  release(actorGuid: string, slotId: number): void {
    const owner = this.owners.get(slotId);
    this.subsystems.releaseSlot(slotId, owner);
    if (this.byGuid.get(actorGuid) === slotId) this.byGuid.delete(actorGuid);
    if (owner && this.byActor.get(owner) === slotId) this.byActor.delete(owner);
    this.owners.delete(slotId);
    this.free.push(slotId);
  }

  /** The render slot this actor's own commands target. Never resolve one
   * through a guid: a same-guid duplicate spawned later owns that. */
  actorSlot(actor: Actor): number | undefined {
    const slot = this.byActor.get(actor);
    return slot !== undefined && this.owners.get(slot) === actor ? slot : undefined;
  }

  /** The slot recorded for this actor, without checking it still owns it. */
  recordedSlot(actor: Actor): number | undefined {
    return this.byActor.get(actor);
  }

  /** The slot of a guid's first-spawned live actor, the one guid lookups resolve. */
  guidSlot(guid: string): number | undefined {
    const actor = this.host.findActor(guid);
    return actor ? this.actorSlot(actor) : undefined;
  }

  owner(slotId: number): Actor | undefined {
    return this.owners.get(slotId);
  }

  hasGuid(guid: string): boolean {
    return this.byGuid.has(guid);
  }

  /** Guids holding a slot (stats `liveActors`). */
  get guidCount(): number {
    return this.byGuid.size;
  }

  /** Live `[guid, latest slot]` entries in insertion order; releasing while iterating is safe. */
  guidEntries(): IterableIterator<[string, number]> {
    return this.byGuid.entries();
  }
}
