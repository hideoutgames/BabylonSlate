import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createWorldSnapshot,
  stringifyWorldSnapshot,
} from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import { replayTracePayload } from "./trace-replay";

describe("runtime trace recorder", () => {
  it("records each tick's script messages and diagnostics on its own trace frame", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
    try {
      await runtime.loadScripts([{ assetGuid: "logger", classId: "Logger", anchors: [],
        source: 'let tick = 0; export function onTick(ctx) { tick++; ctx.log("log", "Script", "tick " + tick); ctx.log("error", "Script", "error " + tick); }',
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }] }]);
      runtime.spawnScriptedActor({ classId: "Logger" });
      runtime.start();
      runtime.executeConsoleCommand("snapshot start");
      runtime.tick();
      runtime.tick();
      runtime.executeConsoleCommand("snapshot stop");
      expect(runtime.stopTrace()!.frames.map((frame) => frame.logs)).toEqual([
        [{ severity: "log", category: "Script", message: "tick 1" }, { severity: "error", category: "Script", message: "error 1" }],
        [{ severity: "log", category: "Script", message: "tick 2" }, { severity: "error", category: "Script", message: "error 2" }],
      ]);
    } finally { runtime.stop(); }
  });

  it("records live object references and collections without interrupting ticks", () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
    try {
      const world = runtime.getWorld();
      const actor = world.createActor({ classId: "Actor", guid: "target" });
      const component = world.createComponent({ classId: "ActorComponent", guid: "component" });
      actor.attachComponent(component);
      world.spawnActorNow(actor);
      actor.setVariable("Target", actor);
      actor.setVariable("Collection", new Map([["Component", component]]));
      runtime.start();
      runtime.executeConsoleCommand("snapshot start");
      runtime.tick();
      runtime.tick();
      runtime.executeConsoleCommand("snapshot stop");
      const trace = runtime.stopTrace()!;
      expect(trace.frames).toHaveLength(2);
      const snapshot = JSON.parse(trace.frames[1]!.snapshotText!);
      expect(snapshot.actors[0].variables).toEqual({
        Target: { guid: "target", classId: "Actor" },
        Collection: { Component: { guid: "component", classId: "ActorComponent" } },
      });
    } finally { runtime.stop(); }
  });

  it("records a session that replays to the same world snapshot", () => {
    const options = {
      seed: 9,
      seedDemoActors: false as const,
      preferSoftwarePhysics: true,
      dt: 1 / 60,
    };
    const commands: CommandMessage[] = [];
    const recorded = createInProcessRuntime({
      ...options,
      onCommand: (command) => commands.push(command),
    });
    recorded.start();
    recorded.executeConsoleCommand("snapshot start");
    for (let i = 0; i < 8; i++) recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const payload = recorded.stopTrace();
    expect(payload).not.toBeNull();
    expect(payload!.seed).toBe(9);
    expect(payload!.frames.length).toBe(8);
    expect(commands.some((command) => command.type === "trace")).toBe(true);
    const recordedSnap = payload!.frames.at(-1)?.snapshotText;
    recorded.stop();

    const replay = createInProcessRuntime(options);
    replay.start();
    for (let i = 0; i < 8; i++) replay.tick();
    const replaySnap = stringifyWorldSnapshot(
      createWorldSnapshot(replay.getWorld()),
    );
    expect(replaySnap).toBe(recordedSnap);
    replay.stop();
  });

  it("records undilated dt while slomo is active", () => {
    const recorded = createInProcessRuntime({
      seed: 3,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      dt: 1 / 60,
    });
    recorded.start();
    recorded.executeConsoleCommand("slomo 2");
    recorded.executeConsoleCommand("snapshot start");
    recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const payload = recorded.stopTrace();
    expect(recorded.getWorld().clock.dt).toBeCloseTo(2 / 60);
    expect(payload?.dt).toBeCloseTo(1 / 60);
    const frame = JSON.parse(payload!.frames[0]!.snapshotText ?? "{}") as {
      dt: number;
    };
    expect(frame.dt).toBeCloseTo(1 / 60);
    recorded.stop();
  });

  it("finalizes an in-flight recording when the session stops", () => {
    const commands: CommandMessage[] = [];
    const recorded = createInProcessRuntime({
      seed: 4,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      dt: 1 / 60,
      onCommand: (command) => commands.push(command),
    });
    recorded.start();
    recorded.executeConsoleCommand("snapshot start");
    recorded.tick();
    recorded.stop();
    const payload = recorded.stopTrace();
    expect(payload).not.toBeNull();
    expect(payload!.frames.length).toBe(1);
    expect(payload!.retention).toMatchObject({ complete: true, droppedFrames: 0, stopReason: "session-ended" });
    expect(commands.some((command) => command.type === "trace")).toBe(true);
  });

  it("publishes an oversized-frame stop immediately, preserves prior frames and keeps gameplay ticking", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, traceByteBudget: 2048,
      onCommand: (command) => commands.push(command),
    });
    try {
      runtime.start();
      runtime.executeConsoleCommand("snapshot start");
      runtime.tick();
      const world = runtime.getWorld();
      world.spawnActorNow(world.createActor({
        classId: "Actor", guid: "large", variables: { payload: "x".repeat(4096) },
      }));
      runtime.tick();
      const payload = runtime.stopTrace()!;
      expect(payload.frames.map((frame) => frame.tickIndex)).toEqual([1]);
      expect(payload.retention).toEqual({
        byteBudget: 2048, droppedFrames: 1, complete: false, stopReason: "oversized-frame",
      });
      expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(2048);
      expect(commands.filter((command) => command.type === "trace")).toEqual([
        { type: "trace", payload },
      ]);
      expect(commands).toContainEqual(expect.objectContaining({
        type: "log", severity: "warning", category: "Trace", message: expect.stringContaining("oversized frame"),
      }));
      runtime.tick();
      expect(world.clock.tickIndex).toBe(3);
      runtime.executeConsoleCommand("snapshot stop");
      runtime.stop();
      expect(runtime.stopTrace()).toBe(payload);
      expect(commands.filter((command) => command.type === "trace")).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it("replays recorded input events onto a new runtime", () => {
    const options = {
      seed: 11,
      seedDemoActors: false as const,
      preferSoftwarePhysics: true,
      dt: 1 / 60,
    };
    const recorded = createInProcessRuntime(options);
    const world = recorded.getWorld();
    const jumper = {
      onTick: (
        self: { transform: { position: { y: number } } },
        ctx: { isActionHeld?: (action: string) => boolean },
      ) => {
        if (ctx.isActionHeld?.("Jump")) {
          self.transform.position.y += 1;
        }
      },
    };
    const probe = world.createActor({
      classId: "Actor",
      guid: "probe-1",
      hooks: jumper,
    });
    world.spawnActorNow(probe);
    recorded.start();
    recorded.executeConsoleCommand("snapshot start");
    recorded.pushInput([{ kind: "key", tick: 0, code: "Space", phase: "down" }]);
    recorded.tick();
    recorded.pushInput([{ kind: "key", tick: 1, code: "Space", phase: "down" }]);
    recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const payload = recorded.stopTrace();
    expect(payload).not.toBeNull();
    const recordedSnap = payload!.frames.at(-1)?.snapshotText;
    const recordedWorld = JSON.parse(recordedSnap ?? "{}") as {
      actors: Array<{ transform: { position: number[] } }>;
    };
    expect(recordedWorld.actors[0]?.transform.position[1]).toBe(2);
    recorded.stop();

    const replay = createInProcessRuntime(options);
    const replayWorld = replay.getWorld();
    const replayProbe = replayWorld.createActor({
      classId: "Actor",
      guid: "probe-1",
      hooks: jumper,
    });
    replayWorld.spawnActorNow(replayProbe);
    replay.start();
    replayTracePayload(replay, payload!);
    const replaySnap = stringifyWorldSnapshot(
      createWorldSnapshot(replay.getWorld()),
    );
    expect(replaySnap).toBe(recordedSnap);
    replay.stop();
  });

  describe("time dilation", () => {
    const options = { seed: 5, seedDemoActors: false as const, preferSoftwarePhysics: true, dt: 1 / 60 };
    /** A runtime whose probe moves by the tick's step and climbs while Jump is held. */
    const probeRuntime = (onTick?: (tickIndex: number) => void) => {
      const runtime = createInProcessRuntime(options);
      const world = runtime.getWorld();
      world.spawnActorNow(world.createActor({
        classId: "Actor", guid: "probe",
        hooks: {
          onTick: (self: { transform: { position: { x: number; y: number } } },
            ctx: { dt: number; tickIndex: number; isActionHeld?: (action: string) => boolean }) => {
            self.transform.position.x += ctx.dt;
            if (ctx.isActionHeld?.("Jump")) self.transform.position.y += ctx.dt;
            onTick?.(ctx.tickIndex);
          },
        },
      }));
      runtime.start();
      return runtime;
    };
    const snapshotText = (runtime: ReturnType<typeof probeRuntime>) =>
      stringifyWorldSnapshot({ ...createWorldSnapshot(runtime.getWorld()), dt: options.dt });

    it("replays an input stream recorded with slomo issued mid-tick frame for frame", () => {
      let recorded: ReturnType<typeof probeRuntime> | null = null;
      // slomo 0.5 issued during the third tick (World index 2) takes effect from the fourth.
      recorded = probeRuntime((tickIndex) => {
        if (tickIndex === 2) expect(recorded!.executeConsoleCommand("slomo 0.5").success).toBe(true);
      });
      recorded.executeConsoleCommand("snapshot start");
      for (let tick = 0; tick < 6; tick += 1) {
        if (tick === 1) recorded.pushInput([{ kind: "key", tick, code: "Space", phase: "down" }]);
        if (tick === 4) recorded.pushInput([{ kind: "key", tick, code: "Space", phase: "up" }]);
        recorded.tick();
      }
      recorded.executeConsoleCommand("snapshot stop");
      const payload = recorded.stopTrace()!;
      recorded.stop();
      expect(payload.dt).toBe(1 / 60);
      expect(payload.frames.map((frame) => frame.timeDilation)).toEqual([1, 1, 1, 0.5, 0.5, 0.5]);
      const last = JSON.parse(payload.frames.at(-1)!.snapshotText!) as { actors: Array<{ transform: { position: number[] } }> };
      // Three full steps plus three half steps; Jump held for ticks 2-4.
      expect(last.actors[0]!.transform.position[0]).toBeCloseTo(4.5 / 60, 12);
      expect(last.actors[0]!.transform.position[1]).toBeCloseTo(2.5 / 60, 12);

      const replay = probeRuntime();
      const replayed: string[] = [];
      replayTracePayload({
        pushInput: (events) => replay.pushInput(events),
        setTimeDilation: (rate) => replay.setTimeDilation(rate),
        tick: () => { replay.tick(); replayed.push(snapshotText(replay)); },
      }, payload);
      expect(replayed).toEqual(payload.frames.map((frame) => frame.snapshotText));
      replay.stop();
    });

    it("records dilation 1 on every frame of an undilated run that replays to the same snapshots", () => {
      const recorded = probeRuntime();
      recorded.executeConsoleCommand("snapshot start");
      for (let tick = 0; tick < 3; tick += 1) recorded.tick();
      recorded.executeConsoleCommand("snapshot stop");
      const payload = recorded.stopTrace()!;
      recorded.stop();
      expect(payload.frames.map((frame) => frame.timeDilation)).toEqual([1, 1, 1]);

      // A replay host left in slomo still replays the undilated steps.
      const replay = probeRuntime();
      replay.executeConsoleCommand("slomo 2");
      const replayed: string[] = [];
      replayTracePayload({ pushInput: (events) => replay.pushInput(events), setTimeDilation: (rate) => replay.setTimeDilation(rate),
        tick: () => { replay.tick(); replayed.push(snapshotText(replay)); } }, payload);
      expect(replayed).toEqual(payload.frames.map((frame) => frame.snapshotText));
      replay.stop();
    });

    it("restores a frame's dilation so the next tick takes the recorded step", () => {
      const recorded = probeRuntime();
      recorded.executeConsoleCommand("slomo 0.5");
      recorded.executeConsoleCommand("snapshot start");
      recorded.tick();
      recorded.executeConsoleCommand("snapshot stop");
      const frame = recorded.stopTrace()!.frames.at(-1)!;
      recorded.stop();

      const replay = probeRuntime();
      replay.restoreFromTrace(frame);
      expect(replay.executeConsoleCommand("slomo").output).toBe("slomo 0.5");
      replay.tick();
      expect(replay.getWorld().clock.dt).toBe(0.5 / 60);
      replay.stop();
    });
  });
});
