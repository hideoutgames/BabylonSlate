/**
 * Geometry for `TimelineChart`: tracks of timed samples on one shared time axis. Pure, so the
 * bucketing, scales and hit tests are tested without a canvas.
 */

/** One stacked part of a track's samples, drawn in the colour its CSS custom property holds. */
export type TimelineSegment = {
  label: string;
  /** One value per sample; a missing measurement is NaN. */
  values: ArrayLike<number>;
  /** A CSS custom property, such as `--tick-actors`. */
  color: string;
};

/** A row of the chart: samples at `times`, stacked from `segments`, on its own value scale. */
export type TimelineTrack = {
  id: string;
  label: string;
  /** Sample times on the shared axis, in milliseconds. */
  times: ArrayLike<number>;
  segments: readonly TimelineSegment[];
  /** A budget line; samples whose total exceeds it are marked. */
  threshold?: number;
  /** Shown after values, such as `ms`; empty for counts. */
  unit: string;
};

/** A point or span on the markers row, such as a scene change or a loading screen. */
export type TimelineMarker = {
  atMs: number;
  endMs?: number;
  label: string;
  color: string;
};

export type TimelineDomain = readonly [start: number, end: number];

/** Width in CSS pixels that one bar and its gap take. */
export const TIMELINE_BUCKET_PX = 3;

/** Each sample's stacked total; NaN parts count as nothing, a sample with no finite part is NaN. */
export function timelineTotals(track: TimelineTrack): Float64Array {
  const count = track.times.length;
  const totals = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    let sum = 0;
    let measured = false;
    for (const segment of track.segments) {
      const value = segment.values[index]!;
      if (Number.isFinite(value)) { sum += value; measured = true; }
    }
    totals[index] = measured ? sum : NaN;
  }
  return totals;
}

/** The bucket a time falls in, or -1 outside the domain. */
export function timelineBucket(time: number, domain: TimelineDomain, buckets: number): number {
  const [start, end] = domain;
  if (!Number.isFinite(time) || time < start || time > end || buckets <= 0) return -1;
  const span = end - start;
  if (span <= 0) return 0;
  return Math.min(buckets - 1, Math.floor((time - start) / span * buckets));
}

/** The time at the centre of a bucket. */
export function timelineBucketTime(bucket: number, domain: TimelineDomain, buckets: number): number {
  const [start, end] = domain;
  return start + (bucket + 0.5) / Math.max(1, buckets) * (end - start);
}

/** Per bucket, the sample with the largest total (-1 for an empty bucket): each bar shows its slowest sample. */
export function timelinePeaks(times: ArrayLike<number>, totals: Float64Array, domain: TimelineDomain, buckets: number): Int32Array {
  const peaks = new Int32Array(Math.max(0, buckets)).fill(-1);
  for (let index = 0; index < times.length; index++) {
    const bucket = timelineBucket(times[index]!, domain, buckets);
    if (bucket < 0 || !Number.isFinite(totals[index]!)) continue;
    const held = peaks[bucket]!;
    if (held < 0 || totals[index]! > totals[held]!) peaks[bucket] = index;
  }
  return peaks;
}

/** The top of a track's value axis: its budget or its tallest bar, with headroom. */
export function timelineScale(totals: Float64Array, peaks: Int32Array, threshold?: number): number {
  let top = threshold ?? 0;
  for (const index of peaks) if (index >= 0 && totals[index]! > top) top = totals[index]!;
  return top > 0 ? top * 1.1 : 1;
}

/**
 * The sample a pointer at `bucket` picks: that bucket's bar, else the nearest bar within `reach`
 * buckets either side, so a thin bar is easy to hit. -1 when there is none.
 */
export function timelineHit(peaks: Int32Array, bucket: number, reach = 2): number {
  for (let distance = 0; distance <= reach; distance++) {
    const before = peaks[bucket - distance];
    if (before !== undefined && before >= 0) return before;
    const after = peaks[bucket + distance];
    if (after !== undefined && after >= 0) return after;
  }
  return -1;
}

/** The marker under a pointer at `time`, allowing `slack` milliseconds around a point marker. */
export function timelineMarkerAt(markers: readonly TimelineMarker[], time: number, slack: number): TimelineMarker | null {
  let best: TimelineMarker | null = null;
  let bestDistance = Infinity;
  for (const marker of markers) {
    const end = marker.endMs ?? marker.atMs;
    const distance = time < marker.atMs ? marker.atMs - time : time > end ? time - end : 0;
    if (distance <= slack && distance < bestDistance) { best = marker; bestDistance = distance; }
  }
  return best;
}

/** The previous or next sample in time order from `index`, or `index` itself at an end. */
export function timelineStep(times: ArrayLike<number>, index: number, direction: -1 | 1): number {
  const next = index + direction;
  return next >= 0 && next < times.length ? next : index;
}
