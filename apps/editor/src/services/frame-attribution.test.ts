import { describe, expect, it } from "vitest";
import { attributeLongFrames, FRAME_CALLBACK_KINDS, installFrameAttribution, type FrameCallbackKind } from "./frame-attribution";

const kind = (name: FrameCallbackKind) => FRAME_CALLBACK_KINDS.indexOf(name);

describe("attributeLongFrames", () => {
  it("counts each long frame under the callbacks of ours that ran longest in it, else DOM commits, else none of ours", () => {
    // Frames 16.7 ms apart, then 50 ms (three intervals), 66.7 ms (four) and 83.3 ms (five).
    const frames = [0, 16.7, 33.3, 83.3, 150, 166.7, 250];
    const spans = {
      // A 250 ms timer for 5 ms of the three-interval frame: under half its 33.3 ms past one interval.
      // The render callback for 40 ms of the four-interval frame, and a zero-delay timer for 12 ms of it.
      start: [35, 85, 130],
      end: [40, 125, 142],
      kind: [kind("timer250"), kind("render"), kind("timer0")],
    };
    // The DOM changed during the three-interval frame; nothing ran in the five-interval one.
    const commits = [60];
    expect(attributeLongFrames({ frames, spans, commits }, 0, 250)).toEqual({
      ms: 250, frames: 7, three: { commit: 1 }, four: { render: 1, none: 1 },
    });
    // Only frames within the window count, and a frame interval needs both its ends in it.
    expect(attributeLongFrames({ frames, spans, commits }, 100, 250)).toEqual({ ms: 150, frames: 3, three: {}, four: { none: 1 } });
  });
});

/** A host whose timers and animation frames run when the test says, on a clock the test sets. */
function host() {
  let clock = 0;
  const timers: Array<{ handler: (...args: unknown[]) => void; delay: number; args: unknown[] }> = [];
  const frames: Array<(time: number) => void> = [];
  const cancelled: number[] = [];
  const setTimeout = (handler: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => timers.push({ handler, delay, args });
  const requestAnimationFrame = (callback: (time: number) => void) => frames.push(callback);
  const cancelAnimationFrame = (id: number) => { cancelled.push(id); };
  /** A Worker whose `onmessage` is a prototype accessor, as the browser's is, and which delivers messages to it. */
  class Worker {
    #handler: ((event: unknown) => void) | null = null;
    deliver(data: unknown) { this.#handler?.call(this, { data }); }
    static {
      Object.defineProperty(this.prototype, "onmessage", {
        configurable: true, enumerable: true,
        get(this: Worker) { return this.#handler; },
        set(this: Worker, value: ((event: unknown) => void) | null) { this.#handler = value; },
      });
    }
  }
  const target = { setTimeout, setInterval: setTimeout, requestAnimationFrame, cancelAnimationFrame, Worker } as unknown as typeof globalThis;
  const runFrame = (time: number) => { clock = time; for (const frame of frames.splice(0)) frame(time); };
  return {
    target, timers, frames, cancelled, Worker, runFrame,
    at: (time: number) => { clock = time; }, now: () => clock,
    natives: { setTimeout, requestAnimationFrame, cancelAnimationFrame },
  };
}

describe("installFrameAttribution", () => {
  it("times timers by their delay through one shared trampoline, and the Engine's render callback apart from other frames", () => {
    const fake = host();
    const render = () => { fake.at(fake.now() + 3); };
    const attribution = installFrameAttribution({ target: fake.target, now: fake.now, isRenderCallback: (callback) => callback === render });
    let ran = 0;
    // Two timers of the same delay are handed to the browser as the same function: nothing is made per callback.
    fake.target.setTimeout(() => { ran += 1; fake.at(fake.now() + 50); }, 250);
    fake.target.setTimeout(() => { ran += 1; }, 250);
    expect(fake.timers[0]!.handler).toBe(fake.timers[1]!.handler);
    expect(fake.timers.map((timer) => timer.delay)).toEqual([250, 250]);
    // Animation frames requested by several callbacks are one browser request per frame.
    fake.target.requestAnimationFrame(render);
    fake.target.requestAnimationFrame(() => {});
    expect(fake.frames).toHaveLength(1);
    fake.runFrame(0);
    // The first timer holds the thread for 50 ms of the next frame's interval.
    fake.at(10);
    const first = fake.timers[0]!;
    first.handler(...first.args);
    fake.target.requestAnimationFrame(render);
    fake.runFrame(70);
    expect(ran).toBe(1);
    expect(attribution.read(0, 100)).toMatchObject({ frames: 2, three: {}, four: { timer250: 1 } });
    attribution.stop();
  });

  it("runs, and lets a caller cancel, every queued animation frame callback, and puts the browser's functions back once stopped", () => {
    const fake = host();
    const attribution = installFrameAttribution({ target: fake.target, now: fake.now });
    const calls: string[] = [];
    fake.target.requestAnimationFrame(() => calls.push("kept"));
    const id = fake.target.requestAnimationFrame(() => calls.push("cancelled"));
    fake.target.cancelAnimationFrame(id);
    attribution.stop();
    expect(fake.target.requestAnimationFrame).toBe(fake.natives.requestAnimationFrame);
    expect(fake.target.setTimeout).toBe(fake.natives.setTimeout);
    // A callback queued before the stop still runs on the next frame; its id is cancellable until then.
    expect(fake.target.cancelAnimationFrame).not.toBe(fake.natives.cancelAnimationFrame);
    fake.runFrame(16);
    expect(calls).toEqual(["kept"]);
    expect(fake.target.cancelAnimationFrame).toBe(fake.natives.cancelAnimationFrame);
    // A browser id goes to the browser.
    fake.target.cancelAnimationFrame(7);
    expect(fake.cancelled).toEqual([7]);
  });

  it("times a game worker's message handler set before it began, and puts the handler and the accessor back when stopped", () => {
    const fake = host();
    const descriptor = Object.getOwnPropertyDescriptor(fake.Worker.prototype, "onmessage");
    const worker = new fake.Worker();
    const received: unknown[] = [];
    const handler = (event: unknown) => { received.push((event as { data: unknown }).data); fake.at(fake.now() + 60); };
    (worker as unknown as { onmessage: unknown }).onmessage = handler;
    const attribution = installFrameAttribution({ target: fake.target, now: fake.now, workers: () => [worker as unknown as Worker] });
    // The page still reads its own handler.
    expect((worker as unknown as { onmessage: unknown }).onmessage).toBe(handler);
    fake.target.requestAnimationFrame(() => {});
    fake.runFrame(0);
    fake.at(5);
    worker.deliver("snapshot");
    fake.target.requestAnimationFrame(() => {});
    fake.runFrame(70);
    expect(received).toEqual(["snapshot"]);
    expect(attribution.read(0, 70).four).toEqual({ worker: 1 });
    attribution.stop();
    expect(Object.getOwnPropertyDescriptor(fake.Worker.prototype, "onmessage")).toEqual(descriptor);
    expect((worker as unknown as { onmessage: unknown }).onmessage).toBe(handler);
  });
});
