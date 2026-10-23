import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@haptic/core";
import { TICK_TIMING_PHASES } from "@haptic/debugger";
import { createInProcessRuntime } from "./driver";
import { TickPipeline } from "./tick-pipeline";

afterEach(() => vi.restoreAllMocks());

describe("tick phase timing", () => {
  it("marks every timed phase once per tick, in order, with the scene systems after post-physics", () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: createDefaultScene() });
    runtime.realizePlayWorld();
    runtime.start();
    try {
      const marks = vi.spyOn(TickPipeline.prototype, "markPhase");
      runtime.tick();
      expect(marks.mock.calls.map(([phase]) => phase)).toEqual([...TICK_TIMING_PHASES]);
    } finally {
      runtime.stop();
    }
  });

  it("keeps each phase's time apart and counts every phase but physics as script", () => {
    let now = 0;
    const pipeline = new TickPipeline({ clock: { tickIndex: 0 } } as never, {} as never, {} as never, {} as never,
      { dt: 1 / 60, seed: 1, generation: 1, mode: "play", diagnosticsEnabled: false }, () => now);
    pipeline.beginPhaseTiming();
    const spend = (phase: (typeof TICK_TIMING_PHASES)[number], ms: number) => { pipeline.markPhase(phase); now += ms; };
    spend("gameInstance", 0.5);
    spend("actors", 2);
    spend("physics", 3);
    spend("postPhysics", 1);
    spend("sceneSystems", 4);
    pipeline.closePhaseTiming();
    expect(Object.fromEntries(TICK_TIMING_PHASES.map((phase, index) => [phase, pipeline.lastPhaseMs[index]]))).toEqual({
      gameInstance: 0.5, sceneSubsystems: 0, actors: 2, components: 0, physics: 3, postPhysics: 1, sceneSystems: 4,
    });
    expect(pipeline.lastScriptMs).toBe(7.5);
    expect(pipeline.lastPhysicsMs).toBe(3);
  });
});
