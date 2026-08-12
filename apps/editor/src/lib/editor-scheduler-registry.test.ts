import { describe, expect, it } from "vitest";
import { EditorSchedulerRegistry } from "./editor-scheduler-registry";

describe("EditorSchedulerRegistry", () => {
  it("broadcasts always-render and pause to every registered viewport", () => {
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
      stats: () => ({ renderedFps: 12, invalidationsPerSecond: 1 }),
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
      stats: () => ({ renderedFps: 30, invalidationsPerSecond: 0 }),
    };

    const unregisterA = registry.register(a);
    registry.register(b);
    registry.setAlwaysRender(true);
    registry.setPaused(true);
    expect(a.always).toBe(true);
    expect(b.always).toBe(true);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
    expect(registry.stats()?.renderedFps).toBe(12);

    unregisterA();
    expect(registry.stats()?.renderedFps).toBe(30);
  });

  it("applies the current always-render flag to a newly registered viewport", () => {
    const registry = new EditorSchedulerRegistry();
    registry.setAlwaysRender(true);
    const handle = {
      always: false,
      setAlwaysRender: (value: boolean) => {
        handle.always = value;
      },
      setPaused: () => {},
      stats: () => ({ renderedFps: 0, invalidationsPerSecond: 0 }),
    };
    registry.register(handle);
    expect(handle.always).toBe(true);
  });
});
