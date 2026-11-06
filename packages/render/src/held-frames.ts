/**
 * Why a view held a frame (kept its last image instead of presenting an incoherent one), counted for
 * `RenderDiagnostics.presentation.heldReasons`. The world view's draw names most holds itself (the `reason` of
 * `SceneRenderCoordinator.render`); these labels name the holds it gives no reason for.
 */
export const HELD_FRAME_LABELS = {
  /** The world draw reported not rendered without a reason: its FrameGraph's readiness changed while it drew. */
  invalidated: "World readiness changed during the draw.",
  /** A frame report's capture validated the world frame and found it not ready for presentation. */
  unpresentable: "World frame was not ready for presentation.",
  /** The world's pending presentation (its first frame's admission) was not ready on a loaded view. */
  presentationNotReady: "World presentation was not ready.",
} as const;

/** Where reasons past `MAX_HELD_FRAME_REASONS` are counted. */
export const HELD_FRAME_OTHER = "other";

/** Distinct keys kept, `HELD_FRAME_OTHER` included: a reason can carry a name (a particle system, a failure). */
const MAX_HELD_FRAME_REASONS = 8;

/** A view's held frames by reason, since it was created. */
export class HeldFrameReasons {
  private readonly counts = new Map<string, number>();

  /** Counts one held frame. Once its key exists nothing is allocated: the map updates that key in place. */
  count(reason: string): void {
    const counts = this.counts;
    const count = counts.get(reason);
    if (count !== undefined) {
      counts.set(reason, count + 1);
      return;
    }
    // Room for one more reason while a key is left for `other`.
    const key = counts.size < MAX_HELD_FRAME_REASONS - 1 ? reason : HELD_FRAME_OTHER;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  /** A copy, for diagnostics: callers keep it while counting goes on. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
