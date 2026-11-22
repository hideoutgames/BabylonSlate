/**
 * What ran on the main thread during a Feature Test Check's long animation frames. While a Check runs
 * (`installFrameAttribution`), `requestAnimationFrame`, `setTimeout`, `setInterval` and the `onmessage` handlers of
 * Workers and MessagePorts are wrapped so each callback's start and end land in typed arrays, with no allocation per
 * callback, and a MutationObserver notes when the page's DOM changed (React's commits, whose scheduler task the Check
 * cannot wrap). `stop` removes every wrapper.
 *
 * A long frame is an interval between two animation frames lasting about three display intervals, or four or more
 * (`attributeLongFrames`). It counts under the kind of callback that ran longest in it when our callbacks together ran
 * at least half of its time beyond one interval; else under DOM commits when the DOM changed in it; else under none of
 * ours: the main thread ran nothing of ours for most of it (garbage collection, the browser's own work, or the thread
 * waiting on the GPU process or another process).
 */

/** What a callback was, in the order a report lists them. */
export const FRAME_CALLBACK_KINDS = [
  "render", "frame", "timer0", "timer16", "timer250", "timer500", "timer2000", "timer", "worker", "port",
] as const;
export type FrameCallbackKind = (typeof FRAME_CALLBACK_KINDS)[number];
/** What a long frame counts under: a kind of callback, DOM commits, or none of ours. */
export type LongFrameCause = FrameCallbackKind | "commit" | "none";
export const LONG_FRAME_CAUSES: readonly LongFrameCause[] = [...FRAME_CALLBACK_KINDS, "commit", "none"];

/** A window's long frames: its length, its animation frames, and per cause the long frames of three and of four or more intervals. */
export interface LongFrameAttribution {
  ms: number;
  frames: number;
  three: Partial<Record<LongFrameCause, number>>;
  four: Partial<Record<LongFrameCause, number>>;
}

const DISPLAY_INTERVAL_MS = 1000 / 60;

const KIND = Object.fromEntries(FRAME_CALLBACK_KINDS.map((kind, index) => [kind, index])) as Record<FrameCallbackKind, number>;

/** The kind of a timer by its delay: zero, about one display interval, 250, 500 or 2000 ms, or another. */
export function timerKind(delay: unknown): FrameCallbackKind {
  const ms = Number(delay) || 0;
  if (ms <= 4) return "timer0";
  if (ms >= 10 && ms <= 25) return "timer16";
  if (ms >= 200 && ms <= 300) return "timer250";
  if (ms >= 400 && ms <= 600) return "timer500";
  if (ms >= 1500 && ms <= 2500) return "timer2000";
  return "timer";
}

/** Recorded spans, frames and commits, in time order (`FrameCallbackLog.view`), or a test's. */
export interface FrameRecord {
  frames: ArrayLike<number>;
  spans: { start: ArrayLike<number>; end: ArrayLike<number>; kind: ArrayLike<number> };
  commits: ArrayLike<number>;
}

/**
 * The long frames among `record`'s animation frames that start and end within [`fromMs`, `toMs`], each counted under
 * its cause (module comment).
 */
export function attributeLongFrames(record: FrameRecord, fromMs: number, toMs: number): LongFrameAttribution {
  const result: LongFrameAttribution = { ms: Math.max(0, toMs - fromMs), frames: 0, three: {}, four: {} };
  const { frames, spans, commits } = record;
  const sums = new Float64Array(FRAME_CALLBACK_KINDS.length);
  let span = 0, commit = 0, previous = Number.NaN;
  for (let index = 0; index < frames.length; index++) {
    const time = frames[index]!;
    if (time < fromMs) continue;
    if (time > toMs) break;
    result.frames += 1;
    const start = previous;
    previous = time;
    if (Number.isNaN(start)) continue;
    const intervals = Math.round((time - start) / DISPLAY_INTERVAL_MS);
    if (intervals < 3) continue;
    sums.fill(0);
    while (span < spans.start.length && spans.end[span]! <= start) span++;
    let total = 0;
    for (let at = span; at < spans.start.length && spans.start[at]! < time; at++) {
      const ran = Math.min(spans.end[at]!, time) - Math.max(spans.start[at]!, start);
      if (ran <= 0) continue;
      sums[spans.kind[at]!]! += ran;
      total += ran;
    }
    while (commit < commits.length && commits[commit]! <= start) commit++;
    let cause: LongFrameCause = commit < commits.length && commits[commit]! <= time ? "commit" : "none";
    if (total >= (time - start - DISPLAY_INTERVAL_MS) / 2) {
      let longest = 0;
      for (let kind = 1; kind < sums.length; kind++) if (sums[kind]! > sums[longest]!) longest = kind;
      cause = FRAME_CALLBACK_KINDS[longest]!;
    }
    const counts = intervals === 3 ? result.three : result.four;
    counts[cause] = (counts[cause] ?? 0) + 1;
  }
  return result;
}

/** Spans kept (oldest dropped first): minutes of a Check's callbacks. */
const SPAN_CAPACITY = 1 << 15;
const FRAME_CAPACITY = 1 << 14;
const COMMIT_CAPACITY = 1 << 13;

/** A ring of `Float64Array` values in time order. */
class Ring {
  private readonly values: Float64Array;
  private written = 0;
  constructor(capacity: number) { this.values = new Float64Array(capacity); }
  push(value: number): void { this.values[this.written++ % this.values.length] = value; }
  get last(): number { return this.written ? this.values[(this.written - 1) % this.values.length]! : Number.NaN; }
  /** The values in time order, a copy. */
  ordered(): Float64Array {
    const capacity = this.values.length;
    if (this.written <= capacity) return this.values.slice(0, this.written);
    const at = this.written % capacity;
    const out = new Float64Array(capacity);
    out.set(this.values.subarray(at), 0);
    out.set(this.values.subarray(0, at), capacity - at);
    return out;
  }
}

/**
 * The callbacks, animation frames and DOM commits a Check's wrappers saw. Callbacks nest (a timer set and run inside
 * another callback's task does not, but a handler that calls a wrapped one does): only the outermost is a span, so
 * spans never overlap.
 */
export class FrameCallbackLog {
  private readonly starts = new Ring(SPAN_CAPACITY);
  private readonly ends = new Ring(SPAN_CAPACITY);
  private readonly kinds = new Uint8Array(SPAN_CAPACITY);
  private spans = 0;
  private readonly frames = new Ring(FRAME_CAPACITY);
  private readonly commits = new Ring(COMMIT_CAPACITY);
  private depth = 0;
  private openKind = 0;
  private openStart = 0;

  enter(kind: number, now: number): void {
    if (this.depth++ > 0) return;
    this.openKind = kind;
    this.openStart = now;
  }

  exit(now: number): void {
    if (this.depth === 0 || --this.depth > 0) return;
    this.kinds[this.spans++ % SPAN_CAPACITY] = this.openKind;
    this.starts.push(this.openStart);
    this.ends.push(now);
  }

  /** An animation frame's time (all of its callbacks are given the same one). */
  frame(time: number): void {
    if (time !== this.frames.last) this.frames.push(time);
  }

  commit(now: number): void {
    this.commits.push(now);
  }

  /** Everything kept, in time order (copies). */
  view(): FrameRecord {
    const count = Math.min(this.spans, SPAN_CAPACITY);
    const at = this.spans > SPAN_CAPACITY ? this.spans % SPAN_CAPACITY : 0;
    const kind = new Uint8Array(count);
    kind.set(this.kinds.subarray(at, count), 0);
    kind.set(this.kinds.subarray(0, at), count - at);
    return { frames: this.frames.ordered(), spans: { start: this.starts.ordered(), end: this.ends.ordered(), kind }, commits: this.commits.ordered() };
  }
}

/** A Check's attribution: the long frames of a window, and the removal of its wrappers. */
export interface FrameAttribution {
  read(fromMs: number, toMs: number): LongFrameAttribution;
  stop(): void;
}

type Accessor = { get: (this: object) => unknown; set: (this: object, value: unknown) => void };

/** Animation frame ids the wrapper hands out: far above the browser's own, so a cancel tells them apart. */
const FRAME_ID_BASE = 0x40000000;

/**
 * Wraps the main thread's callback sources until `stop` (module comment). `isRenderCallback` tells the Engine's render
 * callback among animation frame callbacks; `workers` lists Workers whose `onmessage` was set before (the game worker).
 */
export function installFrameAttribution(options: {
  isRenderCallback?: (callback: unknown) => boolean;
  workers?: () => Iterable<Worker>;
  now?: () => number;
  target?: typeof globalThis;
} = {}): FrameAttribution {
  const target = options.target ?? globalThis;
  const now = options.now ?? (() => performance.now());
  const isRender = options.isRenderCallback ?? (() => false);
  const log = new FrameCallbackLog();
  let active = true;
  const restores: Array<() => void> = [];
  const report = (error: unknown) => {
    const reportError = (target as { reportError?: (error: unknown) => void }).reportError;
    if (reportError) reportError.call(target, error);
    else queueMicrotask(() => { throw error; });
  };

  // Animation frames: queued here and run from one browser callback per frame, so no closure is made per request.
  const nativeRequest = target.requestAnimationFrame;
  const nativeCancel = target.cancelAnimationFrame;
  if (typeof nativeRequest === "function" && typeof nativeCancel === "function") {
    let queue: Array<FrameRequestCallback | null> = [], queueIds: number[] = [];
    let running: Array<FrameRequestCallback | null> = [], runningIds: number[] = [];
    let nextId = FRAME_ID_BASE;
    let pending = false;
    const flush = (time: number) => {
      pending = false;
      // The queue runs; callbacks it requests queue for the next frame (the two arrays swap, nothing is made).
      const callbacks = queue, ids = queueIds;
      queue = running;
      queueIds = runningIds;
      running = callbacks;
      runningIds = ids;
      if (active) log.frame(time);
      for (let index = 0; index < running.length; index++) {
        const callback = running[index];
        if (!callback) continue;
        running[index] = null;
        if (active) log.enter(isRender(callback) ? KIND.render : KIND.frame, now());
        try { callback.call(target, time); } catch (error) { report(error); } finally { if (active) log.exit(now()); }
      }
      running.length = runningIds.length = 0;
      // Stopped: once the last queued callbacks ran, their ids are gone and the browser's cancel is back.
      if (!active && !pending && target.cancelAnimationFrame === cancel) target.cancelAnimationFrame = nativeCancel;
    };
    const request = function requestAnimationFrame(callback: FrameRequestCallback): number {
      queue.push(callback);
      const id = nextId++;
      queueIds.push(id);
      if (!pending) {
        pending = true;
        nativeRequest.call(target, flush);
      }
      return id;
    };
    const cancel = function cancelAnimationFrame(id: number): void {
      if (id < FRAME_ID_BASE) { nativeCancel.call(target, id); return; }
      let at = queueIds.indexOf(id);
      if (at >= 0) { queue[at] = null; return; }
      at = runningIds.indexOf(id);
      if (at >= 0) running[at] = null;
    };
    target.requestAnimationFrame = request;
    target.cancelAnimationFrame = cancel;
    restores.push(() => {
      target.requestAnimationFrame = nativeRequest;
      // Callbacks queued here still run on the next frame, and can be cancelled by their ids until then.
      if (!pending) target.cancelAnimationFrame = nativeCancel;
    });
  }

  // Timers: the browser calls one shared trampoline with the callback and its kind as arguments.
  type Timer = (handler: unknown, delay?: number, ...args: unknown[]) => number;
  const nativeTimeout = target.setTimeout;
  const nativeInterval = target.setInterval;
  const trampoline = function (handler: () => void, kind: number) {
    if (!active) { handler.call(target); return; }
    log.enter(kind, now());
    try { handler.call(target); } finally { log.exit(now()); }
  };
  const timer = (native: Timer) => function (this: unknown, handler: unknown, delay?: number): number {
    // A string handler, or one given arguments of its own, runs as it is (unattributed): wrapping it would allocate.
    // eslint-disable-next-line prefer-rest-params
    if (typeof handler !== "function" || arguments.length > 2) return native.apply(target, arguments as unknown as Parameters<Timer>);
    return native.call(target, trampoline, delay, handler, KIND[timerKind(delay)]);
  };
  target.setTimeout = timer(nativeTimeout as unknown as Timer) as unknown as typeof setTimeout;
  target.setInterval = timer(nativeInterval as unknown as Timer) as unknown as typeof setInterval;
  restores.push(() => {
    target.setTimeout = nativeTimeout;
    target.setInterval = nativeInterval;
  });

  // Message handlers: one wrapper per handler set (not per message), each put back at the end.
  const wrapped: Array<{ host: object; accessor: Accessor; handler: unknown; wrapper: unknown }> = [];
  const handlers = new WeakMap<object, unknown>();
  const wrap = (host: object, accessor: Accessor, handler: unknown, kind: number): unknown => {
    if (typeof handler !== "function") return handler;
    const call = handler as (this: unknown, event: unknown) => unknown;
    const wrapper = function (this: unknown, event: unknown) {
      if (!active) return call.call(this, event);
      log.enter(kind, now());
      try { return call.call(this, event); } finally { log.exit(now()); }
    };
    handlers.set(wrapper, handler);
    wrapped.push({ host, accessor, handler, wrapper });
    return wrapper;
  };
  const patch = (prototype: object | undefined, kind: number): Accessor | null => {
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "onmessage");
    if (!prototype || !descriptor?.get || !descriptor.set || !descriptor.configurable) return null;
    const accessor = descriptor as unknown as Accessor;
    Object.defineProperty(prototype, "onmessage", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: object) {
        const handler = accessor.get.call(this);
        return (handler && handlers.get(handler as object)) ?? handler;
      },
      set(this: object, value: unknown) { accessor.set.call(this, wrap(this, accessor, value, kind)); },
    });
    restores.push(() => Object.defineProperty(prototype, "onmessage", descriptor));
    return accessor;
  };
  const workerAccessor = patch((target as { Worker?: { prototype: object } }).Worker?.prototype, KIND.worker);
  patch((target as { MessagePort?: { prototype: object } }).MessagePort?.prototype, KIND.port);
  if (workerAccessor) {
    for (const worker of options.workers?.() ?? []) {
      const handler = workerAccessor.get.call(worker);
      if (typeof handler === "function") workerAccessor.set.call(worker, wrap(worker, workerAccessor, handler, KIND.worker));
    }
  }
  restores.push(() => {
    for (const { host, accessor, handler, wrapper } of wrapped.splice(0)) {
      if (accessor.get.call(host) === wrapper) accessor.set.call(host, handler);
    }
  });

  // DOM commits: a change anywhere in the page, noted once per microtask checkpoint.
  const Observer = (target as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const root = (target as { document?: Document }).document?.documentElement;
  if (Observer && root) {
    const observer = new Observer(() => { if (active) log.commit(now()); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    restores.push(() => observer.disconnect());
  }

  return {
    read: (fromMs, toMs) => attributeLongFrames(log.view(), fromMs, toMs),
    stop: () => {
      if (!active) return;
      active = false;
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}
