import type { DrawPass } from "./draw-passes";
import { FRAME_STAGES, frameStageOf, median, type FrameStage } from "./gpu-frame-probe";

/**
 * GPU time per pass from timer queries (`gpuprobe timers`): each Engine frame is cut into segments at every draw pass
 * boundary (`setDrawPassStageListener`), one elapsed-time query per segment, and a segment's time counts to the stage and
 * the label (a frame graph task's name, an owner pass, or what runs outside the view's passes) running in it. Elapsed
 * queries cannot nest, so a nested pass ends its parent's segment and the parent resumes in a new one; a label's time is
 * the sum of its segments in the frame.
 *
 * Off unless asked for; a run records a fixed number of frames and ends itself. Where the context has no timer queries
 * (`EXT_disjoint_timer_query_webgl2`: WebKit has none) the run ends at once, reporting them absent.
 */

/** What the timers run on: one active elapsed query at a time, read back in a later frame. */
export interface PassTimerHost<Q> {
  /** Begins an elapsed query; null when none can start (no timer queries, or another query is active). */
  begin(): Q | null;
  /** Ends the active query. */
  end(): void;
  /** The query's elapsed GPU time in ns; null while pending. */
  read(query: Q): number | null;
  /** Whether a disjoint event happened since the last call (`GPU_DISJOINT_EXT`): every query in flight is unreliable. */
  disjoint(): boolean;
  release(query: Q): void;
  now(): number;
}

/** A pass's GPU time over a run: per-frame sums, median and mean over the measured frames (absent counts as zero). */
export interface PassTimerEntry {
  stage: FrameStage;
  label: string;
  ms: number;
  meanMs: number;
  /** Frames it ran in. */
  frames: number;
}

export interface PassTimerResult {
  /** Increments with every run, so a reader can tell a new result. */
  id: number;
  /** Whether the context has timer queries; false: nothing was measured. */
  available: boolean;
  frames: number;
  /** Frames dropped for a disjoint event, a query that could not start, or a query already running. */
  discarded: number;
  /** Median whole-frame GPU time: the sum of a frame's segments. */
  frameMs: number | null;
  stages: { stage: FrameStage; ms: number; meanMs: number }[];
  /** In order of first appearance within a frame. */
  passes: PassTimerEntry[];
  failed: string | null;
}

/** Frames a run measures. */
export const PASS_TIMER_FRAMES = 60;
/** Segments per frame; boundaries past it count to the last segment. */
const MAX_SEGMENTS = 512;
/** Longest a run waits for its frames, from its start. */
const PASS_TIMER_TIMEOUT_MS = 10_000;
/** Frames whose queries may be in flight at once. */
const MAX_PENDING = 8;

interface Segment<Q> { stage: FrameStage; label: string; query: Q }
interface PendingFrame<Q> { segments: Segment<Q>[]; times: (number | null)[] }

/** The label work carries before the frame's first pass boundary. */
export const FRAME_START_LABEL = "frame start";

export class GpuPassTimers<Q> {
  private readonly host: PassTimerHost<Q>;
  private framesWanted = PASS_TIMER_FRAMES;
  private recording = false;
  private started = 0;
  private runs = 0;
  private last: PassTimerResult | null = null;
  private frame: PendingFrame<Q> | null = null;
  private stage: FrameStage = "other";
  private label = FRAME_START_LABEL;
  private tailReached = false;
  private invalid = false;
  /** One of this run's queries is active. */
  private active = false;
  private readonly pending: PendingFrame<Q>[] = [];
  private readonly measured: Map<string, number>[] = [];
  private readonly order = new Map<string, { stage: FrameStage; label: string; rank: number }>();
  private discarded = 0;
  /** Told when a run ends, with its result. */
  onFinish: ((result: PassTimerResult) => void) | null = null;

  constructor(host: PassTimerHost<Q>) {
    this.host = host;
  }

  get running(): boolean { return this.recording; }
  /** Whether a frame is being cut into segments now: pass boundaries matter. */
  get inFrame(): boolean { return this.frame !== null; }

  result(): PassTimerResult | null { return this.last; }

  /** Starts a run of `frames` frames; false while one runs. `available` false ends it at once, reporting no timer queries. */
  start(available: boolean, frames = PASS_TIMER_FRAMES): boolean {
    if (this.recording) return false;
    this.framesWanted = Math.max(1, Math.floor(frames));
    this.measured.length = 0;
    this.order.clear();
    this.discarded = 0;
    this.started = this.host.now();
    this.recording = true;
    if (!available) this.finish("no timer queries", false);
    return true;
  }

  /** An Engine frame begins: reads what earlier frames' queries returned, then opens this frame's first segment. */
  frameBegin(): void {
    if (!this.recording) return;
    this.poll();
    if (!this.recording) return;
    if (this.host.now() - this.started > PASS_TIMER_TIMEOUT_MS) return this.finish("the view drew too few frames");
    if (this.frame || this.measured.length + this.pending.length >= this.framesWanted || this.pending.length >= MAX_PENDING) return;
    this.frame = { segments: [], times: [] };
    this.stage = "other";
    this.label = FRAME_START_LABEL;
    this.tailReached = false;
    this.invalid = false;
    this.open();
  }

  /** A draw pass boundary: the pass and label running now (`"tail"`: the frame reached its device-resolution tail). */
  boundary(pass: DrawPass | "tail", label: string): void {
    if (!this.frame) return;
    if (pass === "tail") {
      this.tailReached = true;
      return;
    }
    let stage = frameStageOf(pass) ?? this.stage;
    if (this.tailReached && (stage === "main" || stage === "effects")) stage = "tail";
    if (stage === this.stage && label === this.label) return;
    this.stage = stage;
    this.label = label;
    if (this.frame.segments.length >= MAX_SEGMENTS) return;
    this.close();
    this.open();
  }

  /** The Engine frame ends: its last segment closes and its queries wait to be read. */
  frameEnd(): void {
    const frame = this.frame;
    if (!frame) return;
    this.frame = null;
    this.close();
    if (this.invalid) {
      this.discard(frame);
      return;
    }
    this.pending.push(frame);
  }

  /** Stops a run without a result; the last one stays readable. */
  stop(): void {
    if (this.frame) {
      this.close();
      this.discard(this.frame);
      this.frame = null;
    }
    for (const frame of this.pending.splice(0)) this.release(frame);
    this.recording = false;
  }

  /** Reads finished queries without blocking; exposed for tests. */
  poll(): void {
    if (this.host.disjoint()) {
      for (const frame of this.pending.splice(0)) this.discard(frame);
    }
    while (this.pending.length) {
      const frame = this.pending[0]!;
      let complete = true;
      for (let index = 0; index < frame.segments.length; index++) {
        if (frame.times[index] !== null && frame.times[index] !== undefined) continue;
        const time = this.host.read(frame.segments[index]!.query);
        if (time === null) {
          complete = false;
          break;
        }
        frame.times[index] = time;
      }
      if (!complete) break;
      this.pending.shift();
      this.record(frame);
      this.release(frame);
    }
    if (this.recording && this.measured.length >= this.framesWanted) this.finish(null);
  }

  private open(): void {
    const frame = this.frame!;
    if (this.invalid) return;
    const query = this.host.begin();
    if (query === null) {
      this.invalid = true;
      return;
    }
    this.active = true;
    frame.segments.push({ stage: this.stage, label: this.label, query });
    frame.times.push(null);
  }

  private close(): void {
    if (!this.active) return;
    this.active = false;
    this.host.end();
  }

  private record(frame: PendingFrame<Q>): void {
    const sums = new Map<string, number>();
    frame.segments.forEach((segment, index) => {
      const key = `${segment.stage}\u0000${segment.label}`;
      sums.set(key, (sums.get(key) ?? 0) + frame.times[index]! / 1e6);
      if (!this.order.has(key)) this.order.set(key, { stage: segment.stage, label: segment.label, rank: this.order.size });
    });
    this.measured.push(sums);
  }

  private discard(frame: PendingFrame<Q>): void {
    this.discarded += 1;
    this.release(frame);
  }

  private release(frame: PendingFrame<Q>): void {
    for (const segment of frame.segments) this.host.release(segment.query);
    frame.segments.length = 0;
  }

  private finish(failed: string | null, available = true): void {
    this.stop();
    this.runs += 1;
    this.last = summarisePassTimers(this.measured, this.order, this.discarded, failed, available, this.runs);
    this.onFinish?.(this.last);
  }
}

/** A run's result from its frames' per-key sums (`GpuPassTimers`). */
function summarisePassTimers(
  frames: readonly Map<string, number>[], order: ReadonlyMap<string, { stage: FrameStage; label: string; rank: number }>, discarded: number,
  failed: string | null, available: boolean, id: number,
): PassTimerResult {
  const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const passes: PassTimerEntry[] = [...order].sort((a, b) => a[1].rank - b[1].rank).map(([key, { stage, label }]) => {
    const values = frames.map((frame) => frame.get(key) ?? 0);
    return { stage, label, ms: median(values) ?? 0, meanMs: mean(values), frames: frames.filter((frame) => frame.has(key)).length };
  });
  const stages = FRAME_STAGES.flatMap((stage) => {
    const values = frames.map((frame) => {
      let sum = 0;
      for (const [key, ms] of frame) if (order.get(key)?.stage === stage) sum += ms;
      return sum;
    });
    return passes.some((entry) => entry.stage === stage) ? [{ stage, ms: median(values) ?? 0, meanMs: mean(values) }] : [];
  });
  const totals = frames.map((frame) => [...frame.values()].reduce((sum, ms) => sum + ms, 0));
  return { id, available, frames: frames.length, discarded, frameMs: median(totals), stages, passes, failed };
}

/** A WebGL2 context's timer queries for `GpuPassTimers`; null where it has none. */
export function webglPassTimerHost(gl: WebGL2RenderingContext): PassTimerHost<WebGLQuery> | null {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (!ext) return null;
  const pool: WebGLQuery[] = [];
  return {
    begin: () => {
      // Another elapsed query running (Babylon's frame timer): this one cannot start.
      if (gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return null;
      const query = pool.pop() ?? gl.createQuery();
      if (!query) return null;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      return query;
    },
    end: () => gl.endQuery(ext.TIME_ELAPSED_EXT),
    read: (query) => gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) ? Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) : null,
    disjoint: () => !!gl.getParameter(ext.GPU_DISJOINT_EXT),
    release: (query) => { if (pool.length < 1024) pool.push(query); else gl.deleteQuery(query); },
    now: () => performance.now(),
  };
}
