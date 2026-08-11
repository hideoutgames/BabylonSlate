import { describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "./render-scheduler";

describe("idle editor renders zero frames", () => {
  it("a clean scheduler does not render across many ticks", () => {
    const scheduler = new RenderScheduler();
    let rendered = 0;
    for (let i = 0; i < 120; i++) {
      if (scheduler.shouldRender()) {
        scheduler.noteRendered();
        rendered += 1;
      }
    }
    expect(rendered).toBe(0);
    expect(scheduler.stats().renderedFrames).toBe(0);
  });

  it("invalidation then one render returns to idle", () => {
    const scheduler = new RenderScheduler();
    scheduler.invalidate("snapshot");
    expect(scheduler.shouldRender()).toBe(true);
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("release of continuous lease returns to idle", () => {
    vi.useFakeTimers();
    const scheduler = new RenderScheduler();
    const release = scheduler.acquireContinuous("camera");
    expect(scheduler.shouldRender()).toBe(true);
    scheduler.noteRendered();
    release();
    expect(scheduler.shouldRender()).toBe(false);
    vi.useRealTimers();
  });
});
