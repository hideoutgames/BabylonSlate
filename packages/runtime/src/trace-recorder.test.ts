import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createWorldSnapshot,
  stringifyWorldSnapshot,
} from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";

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
});
