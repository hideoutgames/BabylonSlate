/**
 * Scrub detents: while dragging a number, round values (multiples of 0.1,
 * 0.25, 1, 10 and 100) hold for a few extra pixels before the value moves
 * on. Between detents the value moves at the field's sensitivity, so every
 * value a plain scrub reaches stays reachable and nothing jumps.
 */

type DetentStep = {
  /** The `k`th multiple of the step, exact for whole and decimal steps. */
  at: (k: number) => number;
  /** Size of the step, in value units. */
  size: number;
  /** Pixels the scrub stays on a multiple of this step. */
  holdPx: number;
};

/** Larger steps hold longer; a value takes the hold of the largest step it is a multiple of. */
const DETENT_STEPS: readonly DetentStep[] = [
  { at: (k) => k / 10, size: 0.1, holdPx: 2 },
  { at: (k) => k / 4, size: 0.25, holdPx: 3 },
  { at: (k) => k, size: 1, holdPx: 4 },
  { at: (k) => k * 10, size: 10, holdPx: 5 },
  { at: (k) => k * 100, size: 100, holdPx: 6 },
];

/** Steps closer together than this on screen would only slow the scrub down. */
const MIN_DETENT_SPACING_PX = 8;
/** A hold never takes more than this share of the travel between its detents. */
const MAX_HOLD_SHARE = 0.25;
/** Bounds the walk for extreme drags; far past any real pointer travel. */
const MAX_DETENTS_PER_SCRUB = 10_000;
/** Past this magnitude 0.1 steps lose precision, and round values no longer matter. */
const MAX_DETENT_MAGNITUDE = 1e12;

type ActiveStep = DetentStep & { hold: number };

function activeSteps(sensitivity: number): ActiveStep[] {
  return DETENT_STEPS.flatMap((step) => {
    const spacingPx = step.size / sensitivity;
    if (spacingPx < MIN_DETENT_SPACING_PX) return [];
    return [{ ...step, hold: Math.min(step.holdPx, spacingPx * MAX_HOLD_SHARE) }];
  });
}

/** The first multiple of `step` strictly past `value` in `direction`. */
function nextMultiple(step: DetentStep, value: number, direction: 1 | -1): number {
  let k = Math.floor(value / step.size) - direction;
  while (direction > 0 ? step.at(k) <= value : step.at(k) >= value) k += direction;
  return step.at(k);
}

/**
 * The value `deltaPx` pixels of horizontal drag away from `start`, at
 * `sensitivity` value units per pixel, holding on each detent crossed. The
 * starting value never holds, so a drag responds from its first pixel. The
 * mapping is continuous and monotonic: dragging back retraces the same values.
 */
export function scrubValue(start: number, deltaPx: number, sensitivity: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(deltaPx) || deltaPx === 0) return start;
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) return start + deltaPx * sensitivity;
  const linear = start + deltaPx * sensitivity;
  const steps = activeSteps(sensitivity);
  if (steps.length === 0 || Math.max(Math.abs(start), Math.abs(linear)) > MAX_DETENT_MAGNITUDE) return linear;
  const direction = deltaPx > 0 ? 1 : -1;
  let value = start;
  let remainingPx = Math.abs(deltaPx);
  for (let crossed = 0; crossed < MAX_DETENTS_PER_SCRUB; crossed += 1) {
    let detent = nextMultiple(steps[0]!, value, direction);
    let hold = steps[0]!.hold;
    for (const step of steps.slice(1)) {
      const candidate = nextMultiple(step, value, direction);
      if (candidate === detent) hold = Math.max(hold, step.hold);
      else if (direction > 0 ? candidate < detent : candidate > detent) {
        detent = candidate;
        hold = step.hold;
      }
    }
    const travelPx = Math.abs(detent - value) / sensitivity;
    if (remainingPx < travelPx) return value + direction * remainingPx * sensitivity;
    remainingPx -= travelPx;
    value = detent;
    if (remainingPx <= hold) return value;
    remainingPx -= hold;
  }
  return value + direction * remainingPx * sensitivity;
}
