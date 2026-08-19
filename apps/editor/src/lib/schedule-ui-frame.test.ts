import { describe, expect, it, vi } from "vitest";
import { createUiFrameScheduler } from "./schedule-ui-frame";

describe("createUiFrameScheduler", () => {
  it("coalesces multiple schedule calls into one animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    const scheduler = createUiFrameScheduler({
      now: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancel: vi.fn(),
    });
    const work = vi.fn();
    scheduler.schedule(work);
    scheduler.schedule(work);
    expect(frames).toHaveLength(1);
    expect(work).not.toHaveBeenCalled();
    frames[0]?.(0);
    expect(work).toHaveBeenCalledTimes(1);
    scheduler.schedule(work);
    expect(frames).toHaveLength(2);
  });

  it("runs the latest scheduled work when several callbacks queue before the frame", () => {
    const frames: FrameRequestCallback[] = [];
    const scheduler = createUiFrameScheduler({
      now: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancel: vi.fn(),
    });
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule(first);
    scheduler.schedule(second);
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a pending frame without running work", () => {
    const cancel = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const scheduler = createUiFrameScheduler({
      now: (callback) => {
        frames.push(callback);
        return 7;
      },
      cancel,
    });
    const work = vi.fn();
    scheduler.schedule(work);
    scheduler.cancel();
    expect(cancel).toHaveBeenCalledWith(7);
    frames[0]?.(0);
    expect(work).not.toHaveBeenCalled();
  });

  it("accepts another schedule after a synchronous frame callback", () => {
    const scheduler = createUiFrameScheduler({
      now: (callback) => {
        callback(0);
        return 1;
      },
      cancel: vi.fn(),
    });
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule(first);
    scheduler.schedule(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
