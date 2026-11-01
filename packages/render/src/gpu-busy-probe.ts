import type { AbstractEngine } from "@babylonjs/core";

/**
 * GPU-busy time per frame, measured without timer queries and independently of display pacing: the Feature Test
 * Check's Breakdown turns it on (`gpubusy on`) while it samples. At the end of each Engine frame (after every view's
 * draws and presentation copy) a marker is submitted, a WebGL2 fence or a WebGPU `onSubmittedWorkDone`, and its
 * completion is timestamped. A frame's busy time is its completion minus the later of its submission and the previous
 * frame's completion: the GPU runs frames in order, so when it is still busy with the previous frame the next one starts
 * there. Off, it does nothing.
 *
 * Resolution: WebGL2 fences are polled without blocking (`clientWaitSync` with a zero timeout) from a zero-delay timer
 * while one is outstanding, so a completion is stamped up to one poll late. Browsers clamp nested timers to about 4 ms,
 * which bounds each frame's error; the error does not accumulate (completion times are absolute), so medians over many
 * frames are stable and comparable between steps. `stats().pollMs` reports the mean poll gap actually seen. WebGPU
 * stamps when the promise settles, a microtask after the queue drains.
 */
export interface GpuBusyStats {
  /** Frames whose completion was observed. */
  frames: number;
  medianMs: number;
  p95Ms: number;
  /** Mean gap between fence polls (WebGL2), the per-frame timing resolution; 0 on WebGPU. */
  pollMs: number;
  /** Frames not measured because too many markers were outstanding. */
  skipped: number;
}

/** The fence calls of a WebGL2 context the probe uses. */
export interface FenceContext {
  readonly SYNC_GPU_COMMANDS_COMPLETE: number;
  readonly ALREADY_SIGNALED: number;
  readonly CONDITION_SATISFIED: number;
  readonly WAIT_FAILED: number;
  fenceSync(condition: number, flags: number): WebGLSync | null;
  clientWaitSync(sync: WebGLSync, flags: number, timeout: number): number;
  deleteSync(sync: WebGLSync | null): void;
  flush(): void;
}

/**
 * A submitted frame marker: reports, without blocking, whether the GPU has finished the work submitted before it (true),
 * not yet (false), or cannot tell (null, a lost context). Shared with the frame loop's backpressure (`frame-backpressure.ts`).
 */
export type FrameMarker = { submitted: number; done: () => boolean | null; dispose: () => void; settledAt?: number };
type Marker = FrameMarker;

/** Markers in flight at once; a frame submitted with this many outstanding is skipped rather than queued. */
const MAX_OUTSTANDING = 6;
/** Frames kept per measurement; a Breakdown sample is a few seconds. */
const MAX_FRAMES = 4096;

export class GpuBusyProbe {
  private active = false;
  private readonly outstanding: Marker[] = [];
  private readonly busy = new Float64Array(MAX_FRAMES);
  private count = 0;
  private skipped = 0;
  private lastCompletion = -Infinity;
  private polls = 0;
  private pollSpan = 0;
  private lastPoll = 0;
  private pollScheduled = false;

  private readonly submit: (submitted: number) => Marker | null;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => void;

  constructor(
    submit: (submitted: number) => Marker | null,
    now: () => number = () => performance.now(),
    schedule: (callback: () => void) => void = (callback) => { setTimeout(callback, 0); },
  ) {
    this.submit = submit;
    this.now = now;
    this.schedule = schedule;
  }

  /** Starts a measurement, discarding the previous one. */
  start(): void {
    this.drop();
    this.active = true;
    this.count = 0;
    this.skipped = 0;
    this.lastCompletion = -Infinity;
    this.polls = 0;
    this.pollSpan = 0;
  }

  /** Stops measuring; the results so far stay readable. */
  stop(): void {
    this.active = false;
    this.drop();
  }

  get measuring(): boolean { return this.active; }

  /** Call once at the end of every Engine frame. */
  frameEnd(): void {
    if (!this.active) return;
    if (this.outstanding.length >= MAX_OUTSTANDING) { this.skipped += 1; return; }
    const marker = this.submit(this.now());
    if (!marker) return;
    this.outstanding.push(marker);
    this.requestPoll();
  }

  /** Reads completed markers in submission order. Called by the probe's own timer; exposed for tests. */
  poll(): void {
    this.pollScheduled = false;
    const now = this.now();
    if (this.lastPoll > 0) { this.polls += 1; this.pollSpan += now - this.lastPoll; }
    this.lastPoll = now;
    while (this.outstanding.length) {
      const marker = this.outstanding[0]!;
      const done = marker.done();
      if (done === false) break;
      this.outstanding.shift();
      marker.dispose();
      // A failed wait (a lost context) measures nothing.
      if (done === null) continue;
      const completed = marker.settledAt ?? now;
      const started = Math.max(marker.submitted, this.lastCompletion);
      this.lastCompletion = completed;
      if (this.count < MAX_FRAMES) this.busy[this.count++] = Math.max(0, completed - started);
    }
    if (this.outstanding.length) this.requestPoll();
    else this.lastPoll = 0;
  }

  stats(): GpuBusyStats | null {
    if (!this.count) return null;
    const sorted = Array.from(this.busy.subarray(0, this.count)).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return {
      frames: this.count, medianMs: median, p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
      pollMs: this.polls ? this.pollSpan / this.polls : 0, skipped: this.skipped,
    };
  }

  dispose(): void {
    this.stop();
  }

  private requestPoll(): void {
    if (this.pollScheduled) return;
    this.pollScheduled = true;
    this.schedule(() => this.poll());
  }

  private drop(): void {
    for (const marker of this.outstanding.splice(0)) marker.dispose();
    this.pollScheduled = false;
    this.lastPoll = 0;
  }
}

/** A WebGL2 fence marker, submitted at once and polled without blocking (`clientWaitSync` with a zero timeout). */
export function fenceFrameMarker(gl: FenceContext, submitted: number): FrameMarker | null {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return null;
  // Submit the fence now, so it can signal before the browser's end-of-task flush.
  gl.flush();
  return {
    submitted,
    done: () => {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) return null;
      return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
    },
    dispose: () => gl.deleteSync(sync),
  };
}

/** A WebGPU marker: `queue.onSubmittedWorkDone`, stamped when it settles (`onSettled` then runs); never awaited. */
export function queueFrameMarker(
  queue: { onSubmittedWorkDone(): Promise<unknown> }, submitted: number, now: () => number, onSettled?: () => void,
): FrameMarker {
  const marker: FrameMarker = { submitted, done: () => (marker.settledAt === undefined ? false : true), dispose: () => {} };
  void queue.onSubmittedWorkDone().then(() => {
    marker.settledAt = now();
    onSettled?.();
  }, () => {
    marker.settledAt = now();
    marker.done = () => null;
    onSettled?.();
  });
  return marker;
}

/** The Engine's marker source (WebGL2 fences or the WebGPU queue), or null where it has neither. */
export function engineFrameMarkers(engine: AbstractEngine, now: () => number = () => performance.now(),
  onSettled?: () => void): ((submitted: number) => FrameMarker | null) | null {
  if (engine.isWebGPU) {
    const queue = (engine as unknown as { _device?: { queue?: { onSubmittedWorkDone(): Promise<unknown> } } })._device?.queue;
    return queue && typeof queue.onSubmittedWorkDone === "function" ? (submitted) => queueFrameMarker(queue, submitted, now, onSettled) : null;
  }
  const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
  const version = (engine as unknown as { webGLVersion?: number }).webGLVersion;
  return gl && version === 2 && typeof gl.fenceSync === "function" ? (submitted) => fenceFrameMarker(gl, submitted) : null;
}

/** A probe whose markers are WebGL2 fences, polled without blocking. */
export function createFenceGpuBusyProbe(gl: FenceContext, now?: () => number, schedule?: (callback: () => void) => void): GpuBusyProbe {
  return new GpuBusyProbe((submitted) => fenceFrameMarker(gl, submitted), now, schedule);
}

/** A probe whose markers are WebGPU `queue.onSubmittedWorkDone` promises, stamped when they settle. */
export function createQueueGpuBusyProbe(
  queue: { onSubmittedWorkDone(): Promise<unknown> }, now: () => number = () => performance.now(),
  schedule?: (callback: () => void) => void,
): GpuBusyProbe {
  let probe: GpuBusyProbe | null = null;
  probe = new GpuBusyProbe((submitted) => queueFrameMarker(queue, submitted, now, () => probe?.poll()), now, schedule ?? (() => {}));
  return probe;
}

const probes = new WeakMap<AbstractEngine, GpuBusyProbe | null>();

/** The Engine's probe (one per Engine: GPU work is Engine-wide), installed at its frame end; null without fences. */
export function engineGpuBusyProbe(engine: AbstractEngine): GpuBusyProbe | null {
  if (probes.has(engine)) return probes.get(engine)!;
  let probe: GpuBusyProbe | null = null;
  if (engine.isWebGPU) {
    const queue = (engine as unknown as { _device?: { queue?: { onSubmittedWorkDone(): Promise<unknown> } } })._device?.queue;
    if (queue && typeof queue.onSubmittedWorkDone === "function") probe = createQueueGpuBusyProbe(queue);
  } else {
    const gl = (engine as unknown as { _gl?: WebGL2RenderingContext; webGLVersion?: number })._gl;
    const version = (engine as unknown as { webGLVersion?: number }).webGLVersion;
    if (gl && version === 2 && typeof gl.fenceSync === "function") probe = createFenceGpuBusyProbe(gl);
  }
  probes.set(engine, probe);
  if (probe) {
    const observer = engine.onEndFrameObservable.add(() => probe!.frameEnd());
    engine.onDisposeObservable.addOnce(() => {
      engine.onEndFrameObservable.remove(observer);
      probe!.dispose();
    });
  }
  return probe;
}

/** The Engine's probe if one was ever installed, without installing one. */
export function existingGpuBusyProbe(engine: AbstractEngine): GpuBusyProbe | null {
  return probes.get(engine) ?? null;
}
