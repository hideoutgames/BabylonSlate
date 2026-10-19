/**
 * How a one-shot thumbnail capture ended. Only `captured` carries an image; the
 * asset keeps its type icon otherwise, and the owner of the queue decides what
 * happens next from the reason:
 * - `expired`: the capture was still wanted, but its own time limits ran out.
 *   `ceiling`: it reached its ceiling while shaders kept finishing, so a longer
 *   ceiling may let it finish. `bound`: a wait saw no progress for its whole bound
 *   (or the frame graph's preparation did), which a longer ceiling does not
 *   change.
 * - `failed`: nothing to capture or nothing drawable (an unreadable source, an
 *   unavailable Material, an empty Prefab, a render error). Another attempt
 *   would end the same way.
 * - `cancelled`: the owner stopped wanting it (superseded, interrupted or closed).
 */
export type ThumbnailCaptureResult =
  | { outcome: "captured"; png: Uint8Array }
  | { outcome: "expired"; reason: "ceiling" | "bound" }
  | { outcome: "failed" }
  | { outcome: "cancelled" };

/**
 * Why a capture ended without an image. Cancellation wins over everything else.
 * With `time` (the exit of a wait, or of an error that may have been a time
 * limit) the capture expired when it reached its `ceiling`, or when a wait's
 * bound ran out (`stalled`); without it nothing about time ended the capture.
 */
export function thumbnailMiss(wanted: boolean, time?: { ceiling: number; stalled: boolean }): ThumbnailCaptureResult {
  if (!wanted) return { outcome: "cancelled" };
  if (time && performance.now() >= time.ceiling) return { outcome: "expired", reason: "ceiling" };
  return time?.stalled ? { outcome: "expired", reason: "bound" } : { outcome: "failed" };
}
