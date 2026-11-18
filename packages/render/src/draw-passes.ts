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
 * - `cull`: the `Forward cull` task, with the view's occlusion filter that runs in it
 * - `readiness`: the frame's readiness work around the graph's draw (membership sync, shadow admission, strict probes)
 * - `particles`: CPU particle animation (each system's `animate`, which Babylon runs inside `Scene.render`)
 * - `observers`: the Scene's before-render stage (camera updates and the `onBeforeRenderObservable` observers) outside
 *   the owner passes they open (Mirror update checks, capture eligibility, glyph atlas uploads)
 * - `other`: the rest (clears, a view's own output copy without a chain, editor overlays, animations, world matrices,
 *   the frame graph's own overhead)
 *
 * `cull`, `readiness`, `particles` and `observers` exist for the time split (`drawPassMs`); they normally draw nothing.
 */
export const DRAW_PASSES = [
  "objects", "geometry", "shadows", "captures", "mirrors", "probes", "water", "outlines", "post", "layers",
  "cull", "readiness", "particles", "observers", "other",
] as const;
export type DrawPass = (typeof DRAW_PASSES)[number];
export type DrawPassCounts = Record<DrawPass, number>;

export function emptyDrawPasses(): DrawPassCounts {
  return {
    objects: 0, geometry: 0, shadows: 0, captures: 0, mirrors: 0, probes: 0, water: 0, outlines: 0, post: 0, layers: 0,
    cull: 0, readiness: 0, particles: 0, observers: 0, other: 0,
  };
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
  /** What each open pass is called for the GPU pass timers: its frame graph task's name, else its pass. */
  private readonly labels: string[] = new Array<string>(MAX_DEPTH).fill("other");
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
    this.labels[0] = "other";
    this.mark = readEngineDrawCalls(this.engine);
    this.timed = this.timingRequested;
    if (this.timed) {
      for (let index = 0; index < DRAW_PASSES.length; index += 1) this.currentMs[DRAW_PASSES[index]!] = 0;
      this.timeMark = performance.now();
    }
  }

  enter(pass: DrawPass, owner: boolean, label?: string): void {
    this.flush();
    const depth = ++this.depth;
    if (depth >= MAX_DEPTH) return;
    if (this.owners[depth - 1]) {
      this.passes[depth] = this.passes[depth - 1]!;
      this.owners[depth] = true;
      this.labels[depth] = this.labels[depth - 1]!;
    } else {
      this.passes[depth] = pass;
      this.owners[depth] = owner;
      this.labels[depth] = label ?? pass;
    }
    stageListener?.(this.passes[depth]!, this.labels[depth]!);
  }

  leave(): void {
    if (this.depth === 0) return;
    this.flush();
    this.depth -= 1;
    stageListener?.(this.pass, this.labels[Math.min(this.depth, MAX_DEPTH - 1)]!);
  }

  /** The pass running now: the one a draw made at this moment counts to. */
  get pass(): DrawPass {
    return this.passes[Math.min(this.depth, MAX_DEPTH - 1)]!;
  }

  /** The open pass's label (`enter`). */
  get label(): string {
    return this.labels[Math.min(this.depth, MAX_DEPTH - 1)]!;
  }

  /** Whether an owner pass (a capture, mirror, probe, water reflection or Scene Layer) is running. */
  get inOwner(): boolean {
    return this.owners[Math.min(this.depth, MAX_DEPTH - 1)]!;
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

/**
 * Told the pass running now and its label (its frame graph task's name, an owner pass's name, else the pass) at every
 * pass boundary of the attributed frame, `"other"` as the frame begins and `"other"`, `"after view"` once it ends, and
 * `"tail"` once the frame reaches its device-resolution tail (`markFrameTail`). Set only while the GPU probe's serialised
 * frame renders or its pass timers record (`gpu-probe-engine.ts`); null otherwise, so a frame pays one null check per
 * boundary.
 */
let stageListener: DrawPassStageListener | null = null;
export type DrawPassStageListener = (pass: DrawPass | "tail", label: string) => void;

export function setDrawPassStageListener(listener: DrawPassStageListener | null): void {
  stageListener = listener;
}

/**
 * The attributed frame on `engine` has reached its tail: the passes that write the view's output at its full size (the
 * FSR upscale and sharpening, or the output copy) and what is drawn over it. A no-op outside an attributed frame and inside an owner pass, whose
 * own graph writes its own output.
 */
export function markFrameTail(engine: object): void {
  if (stageListener && active?.engine === engine && !active.inOwner) stageListener("tail", active.label);
}

/** Starts attributing `frame.engine`'s draws to `frame`; call right after the frame's draw counter reset. */
export function beginDrawPassFrame(frame: DrawPassFrame): void {
  frame.begin();
  active = frame;
  stageListener?.("other", "other");
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
  stageListener?.("other", "after view");
}

/** The view drew the frame: its counts become `frame.last`, and on a timed frame its times `frame.lastMs`. */
export function publishDrawPassFrame(frame: DrawPassFrame): void {
  frame.publish();
}

/** Opens `pass` on `engine`'s attributed frame; a no-op outside one (previews, thumbnails, loading work). */
export function enterDrawPass(engine: object, pass: DrawPass, owner = false, label?: string): void {
  if (active?.engine === engine) active.enter(pass, owner, label);
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
 * Counts `task`'s draws and time to `pass` on every frame it runs. Its start runs before any other observer of it, so
 * the task's own before-observers (a shared outline's sync) are the task's; its end runs before any other observer of
 * it, so what those draw (the scene view's capture views, after its shadow maps) is not the task's. Babylon skips the
 * end when a pass throws; the next frame starts balanced.
 */
export function observeTaskDrawPass(task: FrameGraphTask, engine: object, pass: DrawPass, tail = false): void {
  if (observed.has(task)) return;
  observed.add(task);
  // Insert-first observers run in reverse order of their adding: the tail mark runs before the task's pass opens.
  task.onBeforeTaskExecute.add(() => enterDrawPass(engine, pass, false, task.name), undefined, true);
  if (tail) task.onBeforeTaskExecute.add(() => markFrameTail(engine), undefined, true);
  task.onAfterTaskExecute.add(() => leaveDrawPass(engine), undefined, true);
}
