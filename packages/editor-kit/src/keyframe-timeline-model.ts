/**
 * Geometry for `KeyframeTimeline`: the time scale, ruler ticks, frame
 * snapping, and which keys a point or a marquee reaches. Pure, so the
 * component and its tests share one source.
 */

export type KeyframeShape = "diamond" | "circle" | "square" | "hourglass";

export interface KeyframeTimelineKey {
  /** Unique within its row. */
  id: string;
  time: number;
  shape: KeyframeShape;
  /** Drawn after the key, clipped at the next key (an event key's name or first value). */
  label?: string;
}

export interface KeyframeTimelineRow {
  /** Unique among the rows. */
  id: string;
  /** Group rows (objects) are bold and show the keys of their tracks. */
  kind: "group" | "track";
  keys: readonly KeyframeTimelineKey[];
  /** Draw a line between consecutive keys, for values that interpolate. */
  connect?: boolean;
  /** A colour lane: the bar is filled with these colours at their times. */
  gradient?: readonly { time: number; color: string }[];
  /** Drawn faded. */
  muted?: boolean;
}

export interface KeyRef {
  rowId: string;
  keyId: string;
}

/** The visible time range: its first second, and how wide one second is. */
export interface KeyframeTimelineView {
  start: number;
  pixelsPerSecond: number;
}

/** Room left of 0 s, so its keys stay whole. */
export const KEYFRAME_TIMELINE_GUTTER_PX = 10;
/**
 * Room right of the clip's end: wider, so a key on the last frame stays clear
 * of a docked window's resize handle, whose hit area reaches into the window.
 */
export const KEYFRAME_TIMELINE_END_GUTTER_PX = 24;
const MIN_PIXELS_PER_SECOND = 4;
const MAX_PIXELS_PER_SECOND = 4000;
/** The closest two labelled ruler ticks may be. */
const MIN_LABEL_SPACING_PX = 56;

export const keyRefId = (ref: KeyRef): string => `${ref.rowId}\u0000${ref.keyId}`;

export function keyRefFromId(id: string): KeyRef {
  const split = id.indexOf("\u0000");
  return { rowId: id.slice(0, split), keyId: id.slice(split + 1) };
}

export const timeToX = (view: KeyframeTimelineView, time: number): number => (time - view.start) * view.pixelsPerSecond;
export const xToTime = (view: KeyframeTimelineView, x: number): number => view.start + x / view.pixelsPerSecond;

/** Shows 0 s to `length` across `width`, with a gutter at each end. */
export function fitKeyframeView(length: number, width: number): KeyframeTimelineView {
  const usable = Math.max(1, width - KEYFRAME_TIMELINE_GUTTER_PX - KEYFRAME_TIMELINE_END_GUTTER_PX);
  const pixelsPerSecond = clampScale(usable / Math.max(length, 0.01));
  return { start: -KEYFRAME_TIMELINE_GUTTER_PX / pixelsPerSecond, pixelsPerSecond };
}

const clampScale = (value: number) => Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, value));

/** Zooms by `factor` about the pixel `anchorX`, which keeps its time. */
export function zoomKeyframeView(view: KeyframeTimelineView, factor: number, anchorX: number): KeyframeTimelineView {
  const anchor = xToTime(view, anchorX);
  const pixelsPerSecond = clampScale(view.pixelsPerSecond * factor);
  return { start: anchor - anchorX / pixelsPerSecond, pixelsPerSecond };
}

/** Moves the view by `dx` pixels, never further left than the gutter before 0 s. */
export function panKeyframeView(view: KeyframeTimelineView, dx: number): KeyframeTimelineView {
  const start = view.start - dx / view.pixelsPerSecond;
  return { ...view, start: Math.max(-KEYFRAME_TIMELINE_GUTTER_PX / view.pixelsPerSecond, start) };
}

/** `time` on the nearest frame, kept within 0 and `length`. */
export function snapToFrame(time: number, frameRate: number, length: number): number {
  const clamped = Math.min(length, Math.max(0, time));
  if (!(frameRate > 0)) return clamped;
  const snapped = Math.round(clamped * frameRate) / frameRate;
  return Math.min(length, Math.max(0, Number(snapped.toFixed(6))));
}

export const frameAt = (time: number, frameRate: number): number => Math.round(time * frameRate);

export interface RulerTick {
  time: number;
  /** Labelled ticks are full height. */
  label?: string;
}

const SECOND_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function formatTick(time: number, step: number): string {
  if (step >= 1) return `${Math.round(time)}s`;
  // Tenths read with one decimal; quarters and frames need two.
  const digits = Math.abs(step * 10 - Math.round(step * 10)) < 1e-6 ? 1 : 2;
  return `${time.toFixed(digits)}s`;
}

/**
 * Labelled ticks at the smallest step that keeps labels apart (whole frames
 * when zoomed in that far), with unlabelled minor ticks between them: frames
 * when frames are at least 6 px apart, otherwise fifths of the step.
 */
export function rulerTicks(view: KeyframeTimelineView, width: number, frameRate: number): RulerTick[] {
  const minStep = MIN_LABEL_SPACING_PX / view.pixelsPerSecond;
  const frame = frameRate > 0 ? 1 / frameRate : 0;
  let step = SECOND_STEPS.find((candidate) => candidate >= minStep) ?? SECOND_STEPS[SECOND_STEPS.length - 1]!;
  // Zoomed in past a tenth of a second: label whole frames.
  if (frame > 0 && minStep < 0.1) step = Math.max(1, Math.ceil(minStep / frame)) * frame;
  // Frames when they are far enough apart, else fifths of the step; never between frames.
  const minor = frame > 0 && step <= frame * 1.0001 ? step
    : frame > 0 && frame * view.pixelsPerSecond >= 6 ? frame : step / 5;
  const first = Math.max(0, Math.floor(view.start / minor) * minor);
  const last = xToTime(view, width);
  const ticks: RulerTick[] = [];
  const epsilon = minor / 1000;
  for (let index = Math.round(first / minor); index * minor <= last + epsilon; index++) {
    const time = Number((index * minor).toFixed(6));
    if (time < -epsilon) continue;
    const ratio = time / step;
    const labelled = Math.abs(ratio - Math.round(ratio)) < 1e-4;
    ticks.push(labelled ? { time, label: formatTick(time, step) } : { time });
  }
  return ticks;
}

/**
 * Half the hit box of a key, in pixels: 44 pt across for a finger. Boxes never
 * overlap in effect, since a press takes the nearest key within reach.
 */
export const keyReach = (coarse: boolean): number => (coarse ? 22 : 6);

/** The nearest key to `x` in `row` within `reach` pixels. */
export function keyAt(
  row: KeyframeTimelineRow | undefined,
  view: KeyframeTimelineView,
  x: number,
  reach: number,
): KeyframeTimelineKey | undefined {
  if (!row) return undefined;
  let best: KeyframeTimelineKey | undefined;
  let bestDistance = reach + 0.5;
  for (const key of row.keys) {
    const distance = Math.abs(timeToX(view, key.time) - x);
    if (distance < bestDistance) {
      best = key;
      bestDistance = distance;
    }
  }
  return best;
}

/** Keys whose centre lies inside the pixel rectangle; rows are `rowHeight` tall from y 0. */
export function keysInRect(
  rows: readonly KeyframeTimelineRow[],
  rowHeight: number,
  view: KeyframeTimelineView,
  rect: { left: number; top: number; right: number; bottom: number },
): KeyRef[] {
  const refs: KeyRef[] = [];
  rows.forEach((row, index) => {
    const centre = index * rowHeight + rowHeight / 2;
    if (centre < rect.top || centre > rect.bottom) return;
    for (const key of row.keys) {
      const x = timeToX(view, key.time);
      if (x >= rect.left && x <= rect.right) refs.push({ rowId: row.id, keyId: key.id });
    }
  });
  return refs;
}
