import type { AbstractEngine, Effect, Observer } from "@babylonjs/core";

/**
 * Late first draws: Effects drawn for the first time on an Engine once a Play world view presents, and how long the
 * frames that held them took. A program's first draw holds iPad WebKit WebGL2 (about 100 ms each, unmeasured on the
 * device), and no readiness probe sees it, so this is the measurement for it: `trackFirstDraws` records every Effect
 * the Engine draws from its first view on, and a Play handle's `openFirstDrawStats` counts the ones first drawn while
 * it counts (between a world load's first presented frame and the next load). WebGL2 only: on WebGPU a skipped warm
 * draw returns like a real one, and the cost there is per render pipeline, which Babylon's cache misses count.
 *
 * The same session keeps the longest frames it counted, with what they held, since WebKit has no Long Tasks API to
 * say why a Play frame was long: time inside the Engine's frame and outside it, first draws and Effects created.
 */

/** A frame that lasts longer than this is a stall (a long frame), as the Feature Test check counts frames. */
export const FIRST_DRAW_STALL_MS = 100;

/** How many of the longest frames a session keeps. */
export const LONG_FRAMES_KEPT = 8;

/** A frame longer than `FIRST_DRAW_STALL_MS`, from its start to the next frame's start. */
export type LongFrame = {
  ms: number;
  /**
   * Of that, from the Engine's frame begin to its end: the render loop's work, Play's scene render among it. The
   * rest ran outside the Engine's frame (scripts, layout, garbage collection, a blocked main thread) or waited for
   * the next animation frame.
   */
  engineMs: number;
  /** Effects first drawn in it. */
  firstDraws: number;
  /** Effects the Engine created (compiled or started compiling) in it. */
  compiles: number;
};

export type FirstDrawStats = {
  /** Effects first drawn while counting. */
  draws: number;
  /** Of those, Effects the Engine already held when counting began: compiled by the load and not drawn by it. */
  loadCompiled: number;
  /** Frames that held a first draw. */
  frames: number;
  /** Of those frames, the ones longer than `FIRST_DRAW_STALL_MS`. */
  stalls: number;
  /** Most first draws in one frame. */
  mostInFrame: number;
  /** Longest frame that held a first draw, from its start to the next frame's start (0 before one finished). */
  worstFrameMs: number;
  /** Frames counted, with or without a first draw, longer than `FIRST_DRAW_STALL_MS`. */
  longFrames: number;
  /** The longest of them, longest first, at most `LONG_FRAMES_KEPT`. */
  longest: LongFrame[];
};

export type FirstDrawSession = {
  /** Counts from now, against the Effects the Engine holds now. */
  resume(): void;
  /** Stops counting (a world load's frames are not gameplay); totals are kept. */
  pause(): void;
  stats(): FirstDrawStats;
  close(): void;
};

/** Babylon 9.29's draw sinks: every WebGL draw goes through one of them, with the Effect it drew as `_currentEffect`. */
type Draw = (this: DrawEngine, fillMode: number, start: number, count: number, instancesCount?: number) => void;
type DrawEngine = {
  _currentEffect: Effect | null;
  _compiledEffects?: Record<string, Effect>;
  drawElementsType: Draw;
  drawArraysType: Draw;
  createEffect: (...args: unknown[]) => Effect;
};

type Session = {
  stats: FirstDrawStats;
  /** The Effects the Engine held when counting resumed; null while paused. */
  held: WeakSet<Effect> | null;
  /** First draws and Effects created in the current frame, when it began and when its Engine frame ended. */
  inFrame: number;
  compilesInFrame: number;
  frameStart: number;
  engineEnd: number | null;
};

type Tracker = { drawn: WeakSet<Effect>; created: WeakSet<Effect>; sessions: Set<Session> };

const trackers = new WeakMap<AbstractEngine, Tracker>();

/** Records every Effect `engine` draws from now on, once per Engine; WebGPU Engines are left alone. */
export function trackFirstDraws(engine: AbstractEngine): void {
  if (engine.isWebGPU || trackers.has(engine)) return;
  const target = engine as unknown as DrawEngine;
  const tracker: Tracker = { drawn: new WeakSet(), created: new WeakSet(Object.values(target._compiledEffects ?? {})), sessions: new Set() };
  trackers.set(engine, tracker);
  const note = (current: Effect | null) => {
    if (!current || tracker.drawn.has(current)) return;
    tracker.drawn.add(current);
    for (const session of tracker.sessions) {
      if (!session.held) continue;
      session.stats.draws += 1;
      if (session.held.has(current)) session.stats.loadCompiled += 1;
      session.inFrame += 1;
    }
  };
  const drawElements = target.drawElementsType;
  const drawArrays = target.drawArraysType;
  // Fixed parameters, not rest ones: this runs for every draw call.
  target.drawElementsType = function (fillMode, start, count, instancesCount) {
    drawElements.call(this, fillMode, start, count, instancesCount);
    note(this._currentEffect);
  };
  target.drawArraysType = function (fillMode, start, count, instancesCount) {
    drawArrays.call(this, fillMode, start, count, instancesCount);
    note(this._currentEffect);
  };
  // A cache hit returns an Effect seen before; a new one is a compile (WebGL2 links it at its first use).
  const createEffect = target.createEffect;
  target.createEffect = function (this: DrawEngine, ...args: unknown[]) {
    const effect = createEffect.apply(this, args);
    if (!tracker.created.has(effect)) {
      tracker.created.add(effect);
      for (const session of tracker.sessions) if (session.held) session.compilesInFrame += 1;
    }
    return effect;
  };
}

/**
 * Whether some draw on `engine` has drawn with `effect` since its first view; undefined where the Engine is not
 * tracked (WebGPU, or an Engine no view was created on).
 */
export function effectDrawnOn(engine: AbstractEngine, effect: Effect): boolean | undefined {
  return trackers.get(engine)?.drawn.has(effect);
}

/** A counting session on `engine`, paused until `resume`; null where the Engine is not tracked. */
export function openFirstDrawStats(engine: AbstractEngine): FirstDrawSession | null {
  const tracker = trackers.get(engine);
  if (!tracker) return null;
  const session: Session = {
    stats: { draws: 0, loadCompiled: 0, frames: 0, stalls: 0, mostInFrame: 0, worstFrameMs: 0, longFrames: 0, longest: [] },
    held: null, inFrame: 0, compilesInFrame: 0, frameStart: 0, engineEnd: null,
  };
  /** `whole` is false for the frame a pause cuts short: its first draws count, its length does not make it long. */
  const finishFrame = (now: number, whole: boolean) => {
    const ms = now - session.frameStart;
    const stats = session.stats;
    if (session.inFrame > 0) {
      stats.frames += 1;
      if (ms > FIRST_DRAW_STALL_MS) stats.stalls += 1;
      stats.mostInFrame = Math.max(stats.mostInFrame, session.inFrame);
      stats.worstFrameMs = Math.max(stats.worstFrameMs, ms);
    }
    if (whole && ms > FIRST_DRAW_STALL_MS) {
      stats.longFrames += 1;
      const frame: LongFrame = {
        ms, engineMs: (session.engineEnd ?? now) - session.frameStart, firstDraws: session.inFrame, compiles: session.compilesInFrame,
      };
      stats.longest = [...stats.longest, frame].sort((a, b) => b.ms - a.ms).slice(0, LONG_FRAMES_KEPT);
    }
    session.inFrame = 0;
    session.compilesInFrame = 0;
    session.frameStart = now;
    session.engineEnd = null;
  };
  let observers: [Observer<AbstractEngine>, Observer<AbstractEngine>] | null = null;
  const pause = () => {
    if (!session.held) return;
    finishFrame(performance.now(), false);
    session.held = null;
    if (observers) {
      engine.onBeginFrameObservable.remove(observers[0]);
      engine.onEndFrameObservable.remove(observers[1]);
    }
    observers = null;
  };
  tracker.sessions.add(session);
  return {
    resume() {
      if (session.held) return;
      const compiled = (engine as unknown as DrawEngine)._compiledEffects ?? {};
      session.held = new WeakSet(Object.values(compiled));
      session.inFrame = 0;
      session.compilesInFrame = 0;
      session.frameStart = performance.now();
      session.engineEnd = null;
      observers = [
        engine.onBeginFrameObservable.add(() => finishFrame(performance.now(), true)),
        engine.onEndFrameObservable.add(() => { session.engineEnd = performance.now(); }),
      ];
    },
    pause,
    stats: () => ({ ...session.stats, longest: session.stats.longest.map((frame) => ({ ...frame })) }),
    close() {
      pause();
      tracker.sessions.delete(session);
    },
  };
}
