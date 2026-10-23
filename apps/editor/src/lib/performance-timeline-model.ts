import { summarizePerformanceColumns, type PerformanceProfile, type PerformanceStream } from "@haptic/debugger";
import type { TimelineDomain, TimelineMarker } from "@haptic/editor-kit";

/** The frame budget: one frame at the session's frame cap, else at 60 frames per second. */
export const frameBudget = (profile: PerformanceProfile) =>
  profile.identity.frameCap && profile.identity.frameCap > 0 ? 1000 / profile.identity.frameCap : 1000 / 60;

/** Milliseconds or another recorded number to three decimals, or "Unavailable". */
export const formatRecorded = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Unavailable" : value.toFixed(3);

/** One column of a stream, a value per row; NaN throughout when the stream has no such column. */
export function streamColumn(stream: PerformanceStream, column: string): Float64Array {
  const values = new Float64Array(stream.count).fill(NaN);
  const offset = stream.columns.indexOf(column);
  if (offset < 0) return values;
  const width = stream.columns.length;
  let row = 0;
  for (const chunk of stream.chunks) {
    for (let base = 0; base + width <= chunk.length && row < stream.count; base += width) values[row++] = chunk[base + offset]!;
  }
  return values;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2;
}

/**
 * Each tick's time on the frames' clock. Ticks keep the Worker's clock (`elapsedMs`) and frames the
 * host's (`completedAtMs`); a frame names the tick it presents, so the median gap between a tick
 * and the first frame presenting it carries every tick across. That keeps ticks in order and evenly
 * spaced, and places them where they were seen. With no presented tick, the Worker clock is used as is.
 */
export function tickTimes(profile: PerformanceProfile): Float64Array {
  const elapsed = streamColumn(profile.ticks, "elapsedMs");
  const tickIds = streamColumn(profile.ticks, "tickId");
  const presentedAt = new Map<number, number>();
  const frameTicks = streamColumn(profile.frames, "tickId");
  const completed = streamColumn(profile.frames, "completedAtMs");
  for (let row = 0; row < frameTicks.length; row++) {
    if (Number.isFinite(frameTicks[row]!) && Number.isFinite(completed[row]!) && !presentedAt.has(frameTicks[row]!)) {
      presentedAt.set(frameTicks[row]!, completed[row]!);
    }
  }
  const gaps: number[] = [];
  for (let row = 0; row < tickIds.length; row++) {
    const at = presentedAt.get(tickIds[row]!);
    if (at !== undefined && Number.isFinite(elapsed[row]!)) gaps.push(at - elapsed[row]!);
  }
  const offset = gaps.length ? median(gaps) : 0;
  return elapsed.map((value) => value + offset);
}

/** The row of `to` for the tick that row `row` of `from` has: the tick itself, or the first frame presenting it. */
export function linkedRow(from: PerformanceStream, to: PerformanceStream, row: number): number | null {
  const tickId = streamColumn(from, "tickId")[row];
  if (tickId === undefined || !Number.isFinite(tickId)) return null;
  const index = streamColumn(to, "tickId").indexOf(tickId);
  return index < 0 ? null : index;
}

const BYTES_PER_MIB = 1024 * 1024;

/** Each memory sample's accounted texture and geometry, in MiB. */
export function accountedMemoryMiB(stream: PerformanceStream): Float64Array {
  const geometry = streamColumn(stream, "geometryBytes");
  return streamColumn(stream, "textureBytes").map((texture, row) => (texture + geometry[row]!) / BYTES_PER_MIB);
}

/**
 * Loading screens as spans and scene changes as points, from the frames that showed them, and
 * main-thread long tasks as spans, in time order.
 */
export function profileMarkers(profile: PerformanceProfile): TimelineMarker[] {
  const completed = streamColumn(profile.frames, "completedAtMs");
  const interval = streamColumn(profile.frames, "intervalMs");
  const loading = streamColumn(profile.frames, "loading");
  const generation = streamColumn(profile.frames, "sceneGeneration");
  const markers: TimelineMarker[] = [];
  let loadingStart: number | null = null;
  for (let row = 0; row < completed.length; row++) {
    const at = completed[row]!;
    if (loading[row] === 1 && loadingStart === null) {
      loadingStart = at - (Number.isFinite(interval[row]!) ? interval[row]! : 0);
    }
    const ends = loadingStart !== null && (loading[row] !== 1 || row === completed.length - 1);
    if (ends) {
      markers.push({ atMs: Math.max(0, loadingStart!), endMs: loading[row] === 1 ? at : completed[row - 1] ?? at, label: "Loading", color: "--muted-foreground" });
      loadingStart = null;
    }
    if (row > 0 && Number.isFinite(generation[row]!) && generation[row] !== generation[row - 1]) {
      markers.push({ atMs: at, label: "Scene Changed", color: "--foreground" });
    }
  }
  const taskStarts = streamColumn(profile.longTasks, "startedAtMs");
  const taskDurations = streamColumn(profile.longTasks, "durationMs");
  for (let row = 0; row < taskStarts.length; row++) {
    const duration = taskDurations[row]!;
    markers.push({ atMs: taskStarts[row]!, endMs: taskStarts[row]! + duration, label: `Long Task ${Math.round(duration)} ms`, color: "--warning" });
  }
  return markers.sort((a, b) => a.atMs - b.atMs);
}

/** The rows of `stream` whose time falls in `range`, as a stream of their own. */
export function streamInRange(stream: PerformanceStream, times: ArrayLike<number>, range: TimelineDomain): PerformanceStream {
  const width = stream.columns.length;
  const rows: number[] = [];
  let row = 0;
  for (const chunk of stream.chunks) {
    for (let base = 0; base + width <= chunk.length && row < stream.count; base += width, row++) {
      const time = times[row]!;
      if (time >= range[0] && time <= range[1]) for (let column = 0; column < width; column++) rows.push(chunk[base + column]!);
    }
  }
  return { columns: stream.columns, count: rows.length / Math.max(1, width), chunks: rows.length ? [Float64Array.from(rows)] : [] };
}

/** The Summary's statistics for `columns` summed, over the samples in `range`. */
export function summarizeRange(
  stream: PerformanceStream,
  times: ArrayLike<number>,
  range: TimelineDomain,
  columns: readonly string[],
  budgetMs?: number,
) {
  return summarizePerformanceColumns(streamInRange(stream, times, range), columns, budgetMs);
}
