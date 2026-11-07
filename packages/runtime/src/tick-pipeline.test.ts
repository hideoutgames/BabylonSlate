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
    const emitted: unknown[] = [];
    const host = {
      emit: (command: unknown) => emitted.push(command),
      frameId: () => 0,
      liveActors: () => 0,
      objectLifetime: () => ({ collectable: 0, lastPassMs: null }),
    };
    const pipeline = new TickPipeline({ clock: { tickIndex: 0 } } as never, { lastPublishMs: 0, capacity: 0 } as never, {} as never, host as never,
      { dt: 1 / 60, seed: 1, generation: 1, mode: "play", diagnosticsEnabled: false }, () => now);
    pipeline.beginPhaseTiming();
    const spend = (phase: (typeof TICK_TIMING_PHASES)[number], ms: number) => { pipeline.markPhase(phase); now += ms; };
    spend("gameInstance", 0.5);
    spend("actors", 2);
    spend("objects", 0.25);
    spend("physics", 3);
    spend("postPhysics", 1);
    spend("sceneSystems", 4);
    spend("garbageCollection", 0.5);
    pipeline.closePhaseTiming();
    pipeline.finishTick(0, [], 1);
    const [stats] = emitted as Array<{ type: string; phaseMs: number[]; scriptMs: number; physicsMs: number }>;
    expect(stats?.type).toBe("stats");
    expect(Object.fromEntries(TICK_TIMING_PHASES.map((phase, index) => [phase, stats?.phaseMs[index]]))).toEqual({
      gameInstance: 0.5, sceneSubsystems: 0, actors: 2, components: 0, objects: 0.25, physics: 3, postPhysics: 1, sceneSystems: 4, garbageCollection: 0.5,
    });
    expect([stats?.scriptMs, stats?.physicsMs]).toEqual([8.25, 3]);
    expect(pipeline.lastScriptMs).toBe(8.25);
    expect(pipeline.lastPhysicsMs).toBe(3);
  });
});
