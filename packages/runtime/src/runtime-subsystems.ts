import type { Actor } from "@babylonslate/object-model";

/**
 * Lifecycle hooks of a subsystem the runtime driver owns. Construction is its
 * init; every hook is optional and runs synchronously.
 */
export interface RuntimeSubsystem {
  /**
   * Stop, phase 1: the session is already stopped and its pending loads are
   * being cancelled. Release latent continuations; they resume in this order.
   */
  cancelPending?(): void;
  /**
   * The main Scene is being replaced: its departing actors and layers have
   * left the World. Drop state that belonged to that Scene.
   */
  resetForSceneLoad?(): void;
  /**
   * Stop, phase 2: the World, scripts and Scene sources have ended. Release
   * native and host resources and clear host-visible debug state.
   */
  dispose?(): void;
  /**
   * The driver is removing this actor instance, before its despawn and slot
   * release. Drop state keyed by the instance or its components.
   */
  retireActor?(actor: Actor): void;
  /**
   * A render slot returns to the free list, with the actor that held it when
   * one still does. It also follows `retireActor` for the same actor, so it
   * must tolerate repeats.
   */
  releaseSlot?(slotId: number, owner: Actor | undefined): void;
}

/**
 * Ordered set of driver subsystems. Registration order is the order of every
 * hook, so the driver encodes its teardown sequence once, where it registers.
 */
export class RuntimeSubsystems {
  private readonly entries: RuntimeSubsystem[] = [];

  register<T extends RuntimeSubsystem>(subsystem: T): T {
    this.entries.push(subsystem);
    return subsystem;
  }

  cancelPending(): void {
    for (const entry of this.entries) entry.cancelPending?.();
  }

  resetForSceneLoad(): void {
    for (const entry of this.entries) entry.resetForSceneLoad?.();
  }

  dispose(): void {
    for (const entry of this.entries) entry.dispose?.();
  }

  retireActor(actor: Actor): void {
    for (const entry of this.entries) entry.retireActor?.(actor);
  }

  releaseSlot(slotId: number, owner: Actor | undefined): void {
    for (const entry of this.entries) entry.releaseSlot?.(slotId, owner);
  }
}
