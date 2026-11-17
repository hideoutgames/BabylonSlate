import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { engineFrameMarkers, type FrameMarker } from "./gpu-busy-probe";

/** How many rendered frames may be queued on the GPU at once (`framesinflight`); "off" renders every admitted frame. */
type FramesInFlight = "off" | 2 | 3;

const DEFAULT_FRAMES_IN_FLIGHT: FramesInFlight = 2;

export interface FrameBackpressureStats {
  mode: FramesInFlight;
  /** Frames rendered whose GPU work has not been seen to finish. */
  inFlight: number;
  /** Engine frames whose render was skipped because `mode` frames were still queued. */
  skipped: number;
  /**
   * Rendered frames by how many markers were unfinished once each submitted its own (index 0 to 5, the last 5 or more),
   * since the gate was made: the growth over a window says how deep the queue ran in it. Counted in every mode but
   * "off", which submits none.
   */
  inFlightCounts?: number[];
}

/**
 * The Engine frame loop's GPU backpressure. A browser queues a context's GPU work without bound when the GPU is slower
 * than the frame loop: on a software GPU a page built up seconds of queued frames, so every page task, read-back and
 * context teardown (closing the Preview Build's iframe) waited behind them. A rendered frame submits a marker at the
 * Engine's frame end (a WebGL2 fence, `engineFrameMarkers`); a later frame renders only while
 * fewer than `mode` markers are unfinished, so with 2 frame N waits for frame N - 2. Hardware drivers queue two or three
 * frames anyway, so there it rarely skips; it never blocks: markers are polled with a zero timeout, and a skipped frame
 * skips only the render, leaving the previous image presented, while simulation, snapshots and input go on.
 */
export class FrameBackpressure {
  private limit: FramesInFlight = DEFAULT_FRAMES_IN_FLIGHT;
  private readonly outstanding: FrameMarker[] = [];
  private admitted = false;
  private skips = 0;
  private skippedFrame = -1;
  private readonly depths = [0, 0, 0, 0, 0, 0];
  /** The last Engine frame a view rendered in (`renderedThisFrame`). */
  private renderedFrame = -1;

  private readonly submit: ((submitted: number) => FrameMarker | null) | null;
  private readonly frameId: () => number;
  private readonly now: () => number;

  constructor(
    submit: ((submitted: number) => FrameMarker | null) | null,
    frameId: () => number,
    now: () => number = () => performance.now(),
  ) {
    this.submit = submit;
    this.frameId = frameId;
    this.now = now;
  }

  get mode(): FramesInFlight { return this.limit; }

  /**
   * Whether a view rendered in the Engine frame that is ending (read after this gate's own frame end): an Engine frame
   * in which every view was capped, held or skipped submitted no GPU work of its own.
   */
  renderedThisFrame(): boolean { return this.renderedFrame === this.frameId(); }

  /**
   * Whether this Engine frame may render. Called by each view's loop that is about to render; a skip counts once per
   * frame. A loading owner's presentation frame (`loading`) renders past the limit and still counts in flight: it waits
   * for its own GPU completion under its own budget, one attempt at a time, and holding it behind the frames already
   * queued would charge their GPU time (software GL compiling new programs at first draw) to its first-frame deadline.
   */
  admit(loading = false): boolean {
    if (!loading && this.limit !== "off" && this.submit) {
      this.retire();
      if (this.outstanding.length >= this.limit) {
        const frame = this.frameId();
        if (frame !== this.skippedFrame) { this.skippedFrame = frame; this.skips += 1; }
        return false;
      }
    }
    this.admitted = true;
    return true;
  }

  /** At the Engine's frame end: a frame that rendered submits its marker. */
  frameEnd(): void {
    if (!this.admitted) return;
    this.admitted = false;
    this.renderedFrame = this.frameId();
    if (this.limit === "off" || !this.submit) return;
    const marker = this.submit(this.now());
    if (!marker) return;
    this.retire();
    this.outstanding.push(marker);
    this.depths[Math.min(this.outstanding.length, this.depths.length - 1)] += 1;
  }

  setMode(mode: FramesInFlight): void {
    this.limit = mode;
    if (mode === "off") this.drop();
  }

  stats(): FrameBackpressureStats {
    this.retire();
    return { mode: this.limit, inFlight: this.outstanding.length, skipped: this.skips, inFlightCounts: [...this.depths] };
  }

  dispose(): void { this.drop(); }

  private retire(): void {
    while (this.outstanding.length) {
      // A marker that cannot tell (a lost context) no longer holds frames back.
      if (this.outstanding[0]!.done() === false) break;
      this.outstanding.shift()!.dispose();
    }
  }

  private drop(): void {
    for (const marker of this.outstanding.splice(0)) marker.dispose();
  }
}

const gates = new WeakMap<AbstractEngine, FrameBackpressure>();

/** The Engine's backpressure (one per Engine: its GPU queue is shared by every view), installed at its frame end. */
export function engineFrameBackpressure(engine: AbstractEngine): FrameBackpressure {
  const existing = gates.get(engine);
  if (existing) return existing;
  const created = new FrameBackpressure(engineFrameMarkers(engine), () => engine.frameId);
  gates.set(engine, created);
  const observer = engine.onEndFrameObservable.add(() => created.frameEnd());
  engine.onDisposeObservable.addOnce(() => {
    engine.onEndFrameObservable.remove(observer);
    created.dispose();
  });
  return created;
}
