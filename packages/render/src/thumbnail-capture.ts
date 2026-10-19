/**
 * How a one-shot thumbnail capture ended. Only `captured` carries an image; the
 * asset keeps its type icon otherwise, and the owner of the queue decides what
 * happens next from the reason:
 * - `expired`: the capture was still wanted, but its own time bounds ran out
 *   (its ceiling, or a wait that saw no progress). A slower device or a quieter
 *   Engine may finish it, so it is worth another attempt.
 * - `failed`: nothing to capture or nothing drawable (an unreadable source, an
 *   unavailable Material, an empty Prefab, a render error). Another attempt
 *   would end the same way.
 * - `cancelled`: the owner stopped wanting it (superseded, interrupted or closed).
 */
export type ThumbnailCaptureResult =
  | { outcome: "captured"; png: Uint8Array }
  | { outcome: "expired" }
  | { outcome: "failed" }
  | { outcome: "cancelled" };

/**
 * Why a capture ended without an image. Cancellation wins over everything else;
 * `ranOut` says a time bound of the capture ended it.
 */
export function thumbnailMiss(wanted: boolean, ranOut = false): ThumbnailCaptureResult {
  if (!wanted) return { outcome: "cancelled" };
  return { outcome: ranOut ? "expired" : "failed" };
}
