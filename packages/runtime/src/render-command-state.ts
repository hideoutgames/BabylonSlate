import type { Actor } from "@babylonslate/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";

/**
 * What `RenderCommandEmitter` last sent for each render slot's component
 * commands, so a later sync can send only a change or the clearing command. A
 * released slot forgets it: the renderer drops its view with the despawn.
 */
export class RenderCommandState implements RuntimeSubsystem {
  /** Slots whose last `setAreaLights` sent lights. */
  readonly areaLightSlots = new Set<number>();
  /** Slots whose last `setActorOutlines` sent outlines. */
  readonly outlineSlots = new Set<number>();
  /** Last `setActorDeformers` payload per slot, serialized. */
  readonly deformerSnapshots = new Map<number, string>();
  /** Actors whose deformers changed mid-tick; flushed after the tick. */
  readonly dirtyDeformerActors = new Set<Actor>();
  /** Slots with a configured render target capture. */
  readonly captureSlots = new Set<number>();
  /** Slots whose last `setFogVolumes` sent volumes. */
  readonly fogVolumeSlots = new Set<number>();

  releaseSlot(slotId: number, owner: Actor | undefined): void {
    this.areaLightSlots.delete(slotId);
    this.outlineSlots.delete(slotId);
    this.deformerSnapshots.delete(slotId);
    if (owner) this.dirtyDeformerActors.delete(owner);
    this.captureSlots.delete(slotId);
    this.fogVolumeSlots.delete(slotId);
  }
}
