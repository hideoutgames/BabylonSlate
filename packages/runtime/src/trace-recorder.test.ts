import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createWorldSnapshot,
  stringifyWorldSnapshot,
} from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import { replayTracePayload } from "./trace-replay";

describe("runtime trace recorder", () => {
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
    expect(commands.some((command) => command.type === "trace")).toBe(true);
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
});
