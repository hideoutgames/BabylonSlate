import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { currentDrawPass, type DrawPass } from "./draw-passes";

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
  /** Its first draws by the pass that made them (`FirstDrawStats.passes`); absent when it held none. */
  passes?: FirstDrawPasses;
};

/** First draws by the pass that made them (`draw-passes.ts`); `other` also holds those outside a view's frame. */
export type FirstDrawPasses = Partial<Record<DrawPass, number>>;

/**
 * The programs an Engine holds now: how many, how many of them it has never drawn (compiled for nothing so far: each
 * cost a compile), and the drawn ones by the pass that first drew each. And what they are variants of: the shaders
 * they compile (a Material's build, a pass's own shader), the most programs one shader has, and the defines that
 * differ between programs of one shader (`splitBy`: each cause with the shaders it splits, most first).
 */
export type ProgramInventory = { programs: number; neverDrawn: number; passes: FirstDrawPasses } & ProgramVariants;

/** A define that differs between programs of one shader, the defines that split the same shaders, and how many shaders that is. */
export type ProgramSplit = { define: string; with: string[]; shaders: number };
export type ProgramVariants = { shaders: number; mostVariants: number; splitBy: ProgramSplit[] };

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
  /** The first draws by the pass that made them: which of a view's passes the late programs belong to. */
  passes: FirstDrawPasses;
  /** Longest frame that held a first draw, from its start to the next frame's start (0 before one finished). */
  worstFrameMs: number;
  /** Frames counted, with or without a first draw, longer than `FIRST_DRAW_STALL_MS`. */
  longFrames: number;
  /** The longest of them, longest first, at most `LONG_FRAMES_KEPT`. */
  longest: LongFrame[];
};

type FirstDrawSession = {
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
  passesInFrame: FirstDrawPasses;
  compilesInFrame: number;
  frameStart: number;
  engineEnd: number | null;
};

/** `drawn`: each Effect the Engine has drawn, with the pass that first drew it. */
type Tracker = {
  drawn: WeakMap<Effect, DrawPass>; created: WeakSet<Effect>; sessions: Set<Session>;
  /** What the programs are variants of, for the set of programs it was computed from (`programInventory`). */
  variants?: { held: number; programs: number; value: ProgramVariants };
};

const trackers = new WeakMap<AbstractEngine, Tracker>();

/** Records every Effect `engine` draws from now on, once per Engine; WebGPU Engines are left alone. */
export function trackFirstDraws(engine: AbstractEngine): void {
  if (engine.isWebGPU || trackers.has(engine)) return;
  const target = engine as unknown as DrawEngine;
  const tracker: Tracker = { drawn: new WeakMap(), created: new WeakSet(Object.values(target._compiledEffects ?? {})), sessions: new Set() };
  trackers.set(engine, tracker);
  const note = (current: Effect | null) => {
    if (!current || tracker.drawn.has(current)) return;
    const pass = currentDrawPass() ?? "other";
    tracker.drawn.set(current, pass);
    for (const session of tracker.sessions) {
      if (!session.held) continue;
      session.stats.draws += 1;
      if (session.held.has(current)) session.stats.loadCompiled += 1;
      session.inFrame += 1;
      session.stats.passes[pass] = (session.stats.passes[pass] ?? 0) + 1;
      session.passesInFrame[pass] = (session.passesInFrame[pass] ?? 0) + 1;
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
type ShaderName = string | {
  vertex?: string; fragment?: string; vertexElement?: string; fragmentElement?: string; vertexSource?: string; fragmentSource?: string;
} | undefined;
/** The shader an Effect is a program of: its vertex and fragment shaders' names, or their sources where it has none. */
function shaderOf(effect: Effect): string {
  const name = effect.name as ShaderName;
  if (typeof name === "string" || !name) return name ?? "";
  return `${name.vertex ?? name.vertexElement ?? name.vertexSource ?? ""}|${name.fragment ?? name.fragmentElement ?? name.fragmentSource ?? ""}`;
}

/** An Effect's defines by name; a define without a value holds an empty one. */
function definesOf(effect: Effect): Map<string, string> {
  const defines = new Map<string, string>();
  for (const match of (effect.defines ?? "").matchAll(/^#define (\w+)[ \t]*(.*)$/gm)) defines.set(match[1]!, match[2]!.trim());
  return defines;
}

/**
 * What `effects` are variants of. A define splits a shader when its programs do not all hold it with one value;
 * defines that split the same shaders are one cause, named by the shortest of them (a geometry pass's variant differs
 * from the colour pass's by a family of them).
 */
export function programVariants(effects: readonly Effect[]): ProgramVariants {
  const shaders = new Map<string, Effect[]>();
  for (const effect of effects) {
    const shader = shaderOf(effect), programs = shaders.get(shader);
    if (programs) programs.push(effect);
    else shaders.set(shader, [effect]);
  }
  /** Per define, the shaders it splits. */
  const split = new Map<string, string[]>();
  let mostVariants = 0;
  for (const [shader, programs] of shaders) {
    mostVariants = Math.max(mostVariants, programs.length);
    if (programs.length < 2) continue;
    const defines = programs.map(definesOf);
    for (const define of new Set(defines.flatMap((held) => [...held.keys()]))) {
      const first = defines[0]!.get(define);
      if (defines.every((held) => held.get(define) === first)) continue;
      const splits = split.get(define);
      if (splits) splits.push(shader);
      else split.set(define, [shader]);
    }
  }
  const causes = new Map<string, ProgramSplit>();
  for (const [define, splits] of split) {
    const key = splits.join("\n"), cause = causes.get(key);
    if (!cause) causes.set(key, { define, with: [], shaders: splits.length });
    else if (define.length < cause.define.length || (define.length === cause.define.length && define < cause.define)) {
      cause.with.push(cause.define);
      cause.define = define;
    } else cause.with.push(define);
  }
  for (const cause of causes.values()) cause.with.sort();
  return {
    shaders: shaders.size, mostVariants,
    splitBy: [...causes.values()].sort((a, b) => b.shaders - a.shaders || (a.define < b.define ? -1 : 1)),
  };
}

/** The Engine's programs as it holds them now (`ProgramInventory`); null where its draws are not tracked (WebGPU). */
export function programInventory(engine: AbstractEngine): ProgramInventory | null {
  const tracker = trackers.get(engine);
  const compiled = (engine as unknown as DrawEngine)._compiledEffects;
  if (!tracker || !compiled) return null;
  const counts = { programs: 0, neverDrawn: 0, passes: {} as FirstDrawPasses };
  const effects: Effect[] = [];
  // The set of programs, by their ids: what they are variants of is computed again only when it changed.
  let held = 0;
  for (const key in compiled) {
    const effect = compiled[key]!;
    effects.push(effect);
    held += effect.uniqueId + 1;
    counts.programs += 1;
    const pass = tracker.drawn.get(effect);
    if (pass === undefined) counts.neverDrawn += 1;
    else counts.passes[pass] = (counts.passes[pass] ?? 0) + 1;
  }
  if (!tracker.variants || tracker.variants.held !== held || tracker.variants.programs !== effects.length)
    tracker.variants = { held, programs: effects.length, value: programVariants(effects) };
  return { ...counts, ...tracker.variants.value };
}

export function effectDrawnOn(engine: AbstractEngine, effect: Effect): boolean | undefined {
  return trackers.get(engine)?.drawn.has(effect);
}

/** A counting session on `engine`, paused until `resume`; null where the Engine is not tracked. */
export function openFirstDrawStats(engine: AbstractEngine): FirstDrawSession | null {
  const tracker = trackers.get(engine);
  if (!tracker) return null;
  const session: Session = {
    stats: { draws: 0, loadCompiled: 0, frames: 0, stalls: 0, mostInFrame: 0, passes: {}, worstFrameMs: 0, longFrames: 0, longest: [] },
    held: null, inFrame: 0, passesInFrame: {}, compilesInFrame: 0, frameStart: 0, engineEnd: null,
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
        ...(session.inFrame > 0 ? { passes: session.passesInFrame } : {}),
      };
      stats.longest = [...stats.longest, frame].sort((a, b) => b.ms - a.ms).slice(0, LONG_FRAMES_KEPT);
    }
    session.inFrame = 0;
    session.passesInFrame = {};
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
      session.passesInFrame = {};
      session.compilesInFrame = 0;
      session.frameStart = performance.now();
      session.engineEnd = null;
      observers = [
        engine.onBeginFrameObservable.add(() => finishFrame(performance.now(), true)),
        engine.onEndFrameObservable.add(() => { session.engineEnd = performance.now(); }),
      ];
    },
    pause,
    stats: () => ({ ...session.stats, passes: { ...session.stats.passes }, longest: session.stats.longest.map((frame) => ({ ...frame })) }),
    close() {
      pause();
      tracker.sessions.delete(session);
    },
  };
}
