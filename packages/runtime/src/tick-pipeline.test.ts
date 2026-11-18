import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@haptic/core";
import { TICK_TIMING_PHASES } from "@haptic/debugger";
import { createInProcessRuntime } from "./driver";
import { TickPipeline } from "./tick-pipeline";

afterEach(() => vi.restoreAllMocks());

describe("tick phase timing", () => {
  it("marks every timed phase once per tick, in order, with the scene systems after post-physics", () => {
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: createDefaultScene() });
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
    const pipeline = new TickPipeline({ clock: { tickIndex: 0 } } as never, { takeMeanPublishMs: () => 0, capacity: 0 } as never, {} as never, host as never,
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

  it("reports each timing's mean over the ticks since the last stats command, which a whole-millisecond clock leaves exact", () => {
    // Real time in twentieths of a millisecond; the clock the pipeline reads steps in whole milliseconds, as WebKit's
    // does outside cross-origin isolation.
    let twentieths = 0;
    const emitted: Array<{ type: string; phaseMs: number[]; scriptMs: number; physicsMs: number; publishMs: number }> = [];
    const publishes = [0.4, 0.6];
    const host = {
      emit: (command: (typeof emitted)[number]) => emitted.push(command),
      frameId: () => 0,
      liveActors: () => 0,
      objectLifetime: () => ({ collectable: 0, lastPassMs: null }),
    };
    const pipeline = new TickPipeline({ clock: { tickIndex: 0 } } as never,
      { takeMeanPublishMs: () => publishes.shift() ?? 0, capacity: 0 } as never, {} as never, host as never,
      { dt: 1 / 60, seed: 1, generation: 1, mode: "play", diagnosticsEnabled: false }, () => Math.floor(twentieths / 20));
    /** A tick: a quarter millisecond of Actor ticks, then half a millisecond of physics. */
    const tick = () => {
      pipeline.beginPhaseTiming();
      pipeline.markPhase("actors");
      twentieths += 5;
      pipeline.markPhase("physics");
      twentieths += 10;
      pipeline.closePhaseTiming();
      // To the next tick, 16.65 ms on: the ticks start at every twentieth of a millisecond in turn.
      twentieths += 333 - 15;
    };
    tick();
    pipeline.finishTick(0, [], 1);
    // The first command reports its one tick, in whole milliseconds.
    expect(Number.isInteger(emitted[0]!.scriptMs) && Number.isInteger(emitted[0]!.physicsMs)).toBe(true);
    const readings: number[] = [];
    for (let index = 0; index < 20; index++) {
      tick();
      readings.push(pipeline.lastScriptMs);
    }
    // Each tick alone reads 0 or 1 ms.
    expect(readings.every((ms) => ms === 0 || ms === 1)).toBe(true);
    pipeline.finishTick(0, [], 1);
    // The next command covers the twenty ticks since the first: their mean is the real time.
    const second = emitted[1]!;
    expect([second.scriptMs, second.physicsMs, second.phaseMs[TICK_TIMING_PHASES.indexOf("actors")]]).toEqual([0.25, 0.5, 0.25]);
    expect(second.publishMs).toBe(0.6);
    // A command with no tick timed since the last reports the last tick's own timings.
    twentieths += 4000;
    pipeline.finishTick(0, [], 1);
    expect([emitted[2]!.scriptMs, emitted[2]!.physicsMs]).toEqual([pipeline.lastScriptMs, pipeline.lastPhysicsMs]);
  });
});
