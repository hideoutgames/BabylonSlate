import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameFlush } from "./use-debug-console-logs";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    runFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

describe("createFrameFlush", () => {
  it("flushes a burst of schedules once on the next frame", () => {
    vi.useFakeTimers();
    const frames = stubFrames();
    const flush = vi.fn();
    const frame = createFrameFlush(flush);
    for (let index = 0; index < 100; index += 1) frame.schedule();
    expect(flush).not.toHaveBeenCalled();
    frames.runFrame();
    expect(flush).toHaveBeenCalledOnce();
    // The fallback timer belonged to that flush and must not flush again.
    vi.advanceTimersByTime(1_000);
    expect(flush).toHaveBeenCalledOnce();
    frame.schedule();
    frames.runFrame();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("still flushes when frames never run, as in a hidden tab", () => {
    vi.useFakeTimers();
    stubFrames();
    const flush = vi.fn();
    const frame = createFrameFlush(flush, 250);
    frame.schedule();
    frame.schedule();
    vi.advanceTimersByTime(249);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("drops a pending flush on cancel but schedules again afterwards", () => {
    vi.useFakeTimers();
    const frames = stubFrames();
    const flush = vi.fn();
    const frame = createFrameFlush(flush);
    frame.schedule();
    frame.cancel();
    frames.runFrame();
    vi.advanceTimersByTime(1_000);
    expect(flush).not.toHaveBeenCalled();
    frame.schedule();
    frames.runFrame();
    expect(flush).toHaveBeenCalledOnce();
  });
});
