import { describe, expect, it } from "vitest";
import { RenderScheduler } from "@haptic/render/render-scheduler";
import { EditorSchedulerRegistry } from "./editor-scheduler-registry";

/** A viewport registered as the editor's are, over a real render scheduler. */
function viewport() {
  const scheduler = new RenderScheduler();
  return {
    scheduler,
    handle: {
      setAlwaysRender: (value: boolean) => scheduler.setAlwaysRender(value),
      setPaused: (value: boolean) => scheduler.setPaused(value),
      holdFrames: () => scheduler.acquireObstruction(),
    },
  };
}

describe("EditorSchedulerRegistry", () => {
  it("enables always-render on every registered viewport and broadcasts pause", () => {
    const registry = new EditorSchedulerRegistry();
    const a = {
      always: false,
      paused: false,
      setAlwaysRender: (value: boolean) => {
        a.always = value;
      },
      setPaused: (value: boolean) => {
        a.paused = value;
      },
      holdFrames: () => () => {},
    };
    const b = {
      always: false,
      paused: false,
      setAlwaysRender: (value: boolean) => {
        b.always = value;
      },
      setPaused: (value: boolean) => {
        b.paused = value;
      },
      holdFrames: () => () => {},
    };

    registry.register(a);
    registry.register(b);
    registry.setPaused(true);
    expect(a.always).toBe(true);
    expect(b.always).toBe(true);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
  });

  it("applies always-render to a newly registered viewport", () => {
    const registry = new EditorSchedulerRegistry();
    const handle = {
      always: false,
      setAlwaysRender: (value: boolean) => {
        handle.always = value;
      },
      setPaused: () => {},
      holdFrames: () => () => {},
    };
    registry.register(handle);
    expect(handle.always).toBe(true);
  });

  it("pauses a viewport registered while the editor is paused", () => {
    const registry = new EditorSchedulerRegistry();
    registry.setPaused(true);
    const handle = {
      paused: false,
      setAlwaysRender: () => {},
      setPaused: (value: boolean) => {
        handle.paused = value;
      },
      holdFrames: () => () => {},
    };
    registry.register(handle);
    expect(handle.paused).toBe(true);
    registry.setPaused(false);
    expect(handle.paused).toBe(false);
  });

  it("holds every viewport's frames until the hold ends, including one mounted meanwhile, and releases a closed one's hold", () => {
    const registry = new EditorSchedulerRegistry();
    const open = viewport();
    const mounted = viewport();
    registry.register(open.handle);
    expect(open.scheduler.shouldRender()).toBe(true);

    registry.setFramesHeld(true);
    const unregister = registry.register(mounted.handle);
    expect(open.scheduler.shouldRender()).toBe(false);
    expect(mounted.scheduler.shouldRender()).toBe(false);
    unregister();
    expect(mounted.scheduler.gateState().obstructionLeases).toBe(0);

    registry.setFramesHeld(false);
    expect(open.scheduler.shouldRender()).toBe(true);
    // Holding again takes one lease, not another on top of a stale one.
    registry.setFramesHeld(true);
    registry.setFramesHeld(true);
    expect(open.scheduler.gateState().obstructionLeases).toBe(1);
  });

  it("keeps the frame hold, the lifecycle pause and other holds on a viewport independent", () => {
    const registry = new EditorSchedulerRegistry();
    const { scheduler, handle } = viewport();
    registry.register(handle);
    // Another owner of the same gate, such as a loading blocker.
    const releaseLoading = scheduler.acquireObstruction();

    registry.setPaused(true);
    registry.setFramesHeld(true);
    // The app comes back while Save All runs: its frames stay held.
    registry.setPaused(false);
    expect(scheduler.gateState()).toMatchObject({ paused: false, obstructionLeases: 2 });

    // The app goes away, then Save All ends: the viewport stays paused, and
    // the other hold stays.
    registry.setPaused(true);
    registry.setFramesHeld(false);
    expect(scheduler.gateState()).toMatchObject({ paused: true, obstructionLeases: 1 });

    releaseLoading();
    registry.setPaused(false);
    expect(scheduler.shouldRender()).toBe(true);
  });
});
