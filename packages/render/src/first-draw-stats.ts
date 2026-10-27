import type { AbstractEngine, Effect, Observer } from "@babylonjs/core";

/**
 * Late first draws: Effects drawn for the first time on an Engine once a Play world view presents, and how long the
 * frames that held them took. A program's first draw holds iPad WebKit WebGL2 (about 100 ms each, unmeasured on the
 * device), and no readiness probe sees it, so this is the measurement for it: `trackFirstDraws` records every Effect
 * the Engine draws from its first view on, and a Play handle's `openFirstDrawStats` counts the ones first drawn while
 * it counts (between a world load's first presented frame and the next load). WebGL2 only: on WebGPU a skipped warm
 * draw returns like a real one, and the cost there is per render pipeline, which Babylon's cache misses count.
 */

/** A frame holding a first draw that lasts longer than this is a stall, as the Feature Test check counts frames. */
export const FIRST_DRAW_STALL_MS = 100;

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
};

type Session = {
  stats: FirstDrawStats;
  /** The Effects the Engine held when counting resumed; null while paused. */
  held: WeakSet<Effect> | null;
  /** First draws in the current frame, and when it began. */
  inFrame: number;
  frameStart: number;
};

type Tracker = { drawn: WeakSet<Effect>; sessions: Set<Session> };

const trackers = new WeakMap<AbstractEngine, Tracker>();

/** Records every Effect `engine` draws from now on, once per Engine; WebGPU Engines are left alone. */
export function trackFirstDraws(engine: AbstractEngine): void {
  if (engine.isWebGPU || trackers.has(engine)) return;
  const tracker: Tracker = { drawn: new WeakSet(), sessions: new Set() };
  trackers.set(engine, tracker);
  const target = engine as unknown as DrawEngine;
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
    stats: { draws: 0, loadCompiled: 0, frames: 0, stalls: 0, mostInFrame: 0, worstFrameMs: 0 },
    held: null, inFrame: 0, frameStart: 0,
  };
  const finishFrame = (now: number) => {
    if (session.inFrame > 0) {
      const ms = now - session.frameStart;
      const stats = session.stats;
      stats.frames += 1;
      if (ms > FIRST_DRAW_STALL_MS) stats.stalls += 1;
      stats.mostInFrame = Math.max(stats.mostInFrame, session.inFrame);
      stats.worstFrameMs = Math.max(stats.worstFrameMs, ms);
    }
    session.inFrame = 0;
    session.frameStart = now;
  };
  let observer: Observer<AbstractEngine> | null = null;
  const pause = () => {
    if (!session.held) return;
    finishFrame(performance.now());
    session.held = null;
    engine.onBeginFrameObservable.remove(observer);
    observer = null;
  };
  tracker.sessions.add(session);
  return {
    resume() {
      if (session.held) return;
      const compiled = (engine as unknown as DrawEngine)._compiledEffects ?? {};
      session.held = new WeakSet(Object.values(compiled));
      session.inFrame = 0;
      session.frameStart = performance.now();
      observer = engine.onBeginFrameObservable.add(() => finishFrame(performance.now()));
    },
    pause,
    stats: () => ({ ...session.stats }),
    close() {
      pause();
      tracker.sessions.delete(session);
    },
  };
}
