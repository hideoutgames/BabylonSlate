import type { TraceSpriteClip } from "@babylonslate/debugger";
import type { Actor } from "@babylonslate/object-model";

export type SpriteClipState = { assetGuid: string; clipName: string; normalisedTime: number; stateId?: string };

/**
 * The Sprite Animation clip each actor shows, as the Animation Graph and Play
 * Animation last set it, for trace frames and trace restore. Weak Actor keys
 * match the physics sprite-collider state, so a retired actor's clip cannot
 * reach a successor that reuses its guid.
 */
export class SpriteClipTrace {
  private byActor = new WeakMap<Actor, SpriteClipState>();

  set(actor: Actor, clip: SpriteClipState | null): void {
    if (clip) this.byActor.set(actor, { ...clip });
    else this.byActor.delete(actor);
  }

  get(actor: Actor): SpriteClipState | undefined {
    return this.byActor.get(actor);
  }

  /** Live actors' clips in World order. */
  traceStates(actors: readonly Actor[]): TraceSpriteClip[] {
    const rows: TraceSpriteClip[] = [];
    for (const actor of actors) {
      const clip = actor.destroyed ? undefined : this.byActor.get(actor);
      if (!clip) continue;
      rows.push({
        actorGuid: actor.guid,
        stateId: clip.stateId ?? "",
        assetGuid: clip.assetGuid,
        clipName: clip.clipName,
        normalisedTime: clip.normalisedTime,
      });
    }
    return rows;
  }
}
