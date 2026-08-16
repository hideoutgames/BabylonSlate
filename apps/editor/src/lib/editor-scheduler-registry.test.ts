import { describe, expect, it } from "vitest";
import { EditorSchedulerRegistry } from "./editor-scheduler-registry";

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
    };
    registry.register(handle);
    expect(handle.always).toBe(true);
  });
});
