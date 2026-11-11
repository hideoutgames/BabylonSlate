import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { readEngineDrawCalls, type DrawCallEngine } from "./draw-calls";

/**
 * What drew a view's frame (`RenderDiagnostics.drawPasses`), named after the Forward FrameGraph tasks and the owners
 * that draw outside them:
 * - `objects`: the main colour pass (`Forward objects`, and with a water scene copy `Forward transparent` and `Water opaque`)
 * - `geometry`: the geometry pass the spatial effects (AO, SSR, volumetrics) read, and `Screen shadows`
 * - `shadows`: `Forward admitted shadows`, the shadow maps
 * - `captures`: Render Target Captures, Fast ones before the graph and High or Full Quality views after the shadow maps
 * - `mirrors`, `probes`: Mirror and Reflection Probe passes
 * - `water`: the water scene copy and its output, planar reflections and the FFT simulations
 * - `outlines`: `Shared outlines`
 * - `post`: post-process stages and a chain's output copy
 * - `layers`: Scene Layers composited over the world
 * - `other`: the rest (clears, a view's own output copy without a chain, editor overlays)
 */
export const DRAW_PASSES = [
  "objects", "geometry", "shadows", "captures", "mirrors", "probes", "water", "outlines", "post", "layers", "other",
] as const;
export type DrawPass = (typeof DRAW_PASSES)[number];
export type DrawPassCounts = Record<DrawPass, number>;

export function emptyDrawPasses(): DrawPassCounts {
  return { objects: 0, geometry: 0, shadows: 0, captures: 0, mirrors: 0, probes: 0, water: 0, outlines: 0, post: 0, layers: 0, other: 0 };
}

/** Nesting deeper than this counts to the deepest pass tracked. */
const MAX_DEPTH = 32;

/**
 * One view's attribution of its frame's draw calls to passes, reused every frame so it allocates nothing. Each pass
 * reads Babylon's per-frame draw counter (`_drawCalls`, which `beginEngineDrawCallFrame` resets) when it starts and
 * ends, and a draw counts to the innermost pass running, so nested passes are never counted twice. An owner pass (a
 * capture, mirror, probe, water reflection or Scene Layer) keeps everything nested in it, its own graph's shadow maps
 * and post-processing included.
 *
 * Once `timePasses` is called, each frame from the next one on also attributes its main-thread time
 * (`performance.now()`) the same way: what runs between two pass boundaries counts to the innermost pass running, so a
 * frame's pass times add up to the time between its begin and end.
 */
export class DrawPassFrame {
  /** The frame being attributed. */
  readonly current: DrawPassCounts = emptyDrawPasses();
  /** The last frame the view drew (`publishDrawPassFrame`). */
  readonly last: DrawPassCounts = emptyDrawPasses();
  /** The frame being attributed's time by pass, in ms; written only while the frame is timed. */
  readonly currentMs: DrawPassCounts = emptyDrawPasses();
  /** The last timed frame the view drew, in ms; all zero before one. */
  readonly lastMs: DrawPassCounts = emptyDrawPasses();
  readonly engine: DrawCallEngine;
  private readonly passes: DrawPass[] = new Array<DrawPass>(MAX_DEPTH).fill("other");
  private readonly owners: boolean[] = new Array<boolean>(MAX_DEPTH).fill(false);
  private depth = 0;
  private mark = 0;
  /** `timePasses` was called: frames begun from now on are timed. */
  private timingRequested = false;
  /** The frame being attributed is timed (latched at `begin`, so a frame is timed whole or not at all). */
  private timed = false;
  private timeMark = 0;

  constructor(engine: DrawCallEngine) {
    this.engine = engine;
  }

  /** Times every frame begun from now on. */
  timePasses(): void {
    this.timingRequested = true;
  }

  begin(): void {
    for (let index = 0; index < DRAW_PASSES.length; index += 1) this.current[DRAW_PASSES[index]!] = 0;
    this.depth = 0;
    this.passes[0] = "other";
    this.owners[0] = false;
    this.mark = readEngineDrawCalls(this.engine);
    this.timed = this.timingRequested;
    if (this.timed) {
      for (let index = 0; index < DRAW_PASSES.length; index += 1) this.currentMs[DRAW_PASSES[index]!] = 0;
      this.timeMark = performance.now();
    }
  }

  enter(pass: DrawPass, owner: boolean): void {
    this.flush();
    const depth = ++this.depth;
    if (depth >= MAX_DEPTH) return;
    if (this.owners[depth - 1]) {
      this.passes[depth] = this.passes[depth - 1]!;
      this.owners[depth] = true;
    } else {
      this.passes[depth] = pass;
      this.owners[depth] = owner;
    }
  }

  leave(): void {
    if (this.depth === 0) return;
    this.flush();
    this.depth -= 1;
  }

  /** The pass running now: the one a draw made at this moment counts to. */
  get pass(): DrawPass {
    return this.passes[Math.min(this.depth, MAX_DEPTH - 1)]!;
  }

  /** Counts the draws, and on a timed frame the time, since the last read to the pass running now. */
  flush(): void {
    const now = readEngineDrawCalls(this.engine);
    const drawn = now - this.mark;
    this.mark = now;
    const pass = this.passes[Math.min(this.depth, MAX_DEPTH - 1)]!;
    if (drawn > 0) this.current[pass] += drawn;
    if (this.timed) {
      const time = performance.now();
      this.currentMs[pass] += time - this.timeMark;
      this.timeMark = time;
    }
  }

  /** The frame was drawn: its counts, and its times when it was timed, become `last` and `lastMs`. */
  publish(): void {
    for (let index = 0; index < DRAW_PASSES.length; index += 1) {
      const pass = DRAW_PASSES[index]!;
      this.last[pass] = this.current[pass];
      if (this.timed) this.lastMs[pass] = this.currentMs[pass];
    }
  }
}

let active: DrawPassFrame | undefined;

/** Starts attributing `frame.engine`'s draws to `frame`; call right after the frame's draw counter reset. */
export function beginDrawPassFrame(frame: DrawPassFrame): void {
  frame.begin();
  active = frame;
}

/** The pass a draw made now counts to; undefined while no view's frame is being attributed. */
export function currentDrawPass(): DrawPass | undefined {
  return active?.pass;
}

/** Stops attributing; what drew since the last pass boundary counts to the pass running then. */
export function endDrawPassFrame(frame: DrawPassFrame): void {
  if (active !== frame) return;
  frame.flush();
  active = undefined;
}

/** The view drew the frame: its counts become `frame.last`, and on a timed frame its times `frame.lastMs`. */
export function publishDrawPassFrame(frame: DrawPassFrame): void {
  frame.publish();
}

/** Opens `pass` on `engine`'s attributed frame; a no-op outside one (previews, thumbnails, loading work). */
export function enterDrawPass(engine: object, pass: DrawPass, owner = false): void {
  if (active?.engine === engine) active.enter(pass, owner);
}

export function leaveDrawPass(engine: object): void {
  if (active?.engine === engine) active.leave();
}

/** Runs `draw` as `pass`; an owner pass keeps what is drawn nested in it. */
export function withDrawPass<T>(engine: object, pass: DrawPass, draw: () => T, owner = true): T {
  enterDrawPass(engine, pass, owner);
  try {
    return draw();
  } finally {
    leaveDrawPass(engine);
  }
}

const observed = new WeakSet<FrameGraphTask>();

/**
 * Counts `task`'s draws to `pass` on every frame it runs. Its end runs before any other observer of it, so what those
 * draw (the scene view's capture views, after its shadow maps) is not the task's. Babylon skips the end when a pass
 * throws; the next frame starts balanced.
 */
export function observeTaskDrawPass(task: FrameGraphTask, engine: object, pass: DrawPass): void {
  if (observed.has(task)) return;
  observed.add(task);
  task.onBeforeTaskExecute.add(() => enterDrawPass(engine, pass));
  task.onAfterTaskExecute.add(() => leaveDrawPass(engine), undefined, true);
}
