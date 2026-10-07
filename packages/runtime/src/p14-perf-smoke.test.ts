import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  readSnapshotHeader,
  snapshotFloatCount,
} from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

describe("P14 perf smoke", () => {
  it("posts stats near 5 Hz with publish time while snapshot tickIndex stays per tick", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 14,
      maxActors: 8,
      preferSoftwarePhysics: true,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    for (let i = 0; i < 120; i++) runtime.tick();
    const stats = commands.filter((command) => command.type === "stats");
    expect(stats.length).toBeGreaterThanOrEqual(1);
    expect(stats.length).toBeLessThanOrEqual(8);
    // Publish time is reported beside, not inside, the script/physics split.
    for (const command of stats) {
      expect(command.type === "stats" && Number.isFinite(command.publishMs)).toBe(true);
    }
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    expect(readSnapshotHeader(buf).tickIndex).toBe(120);
    runtime.stop();
  });
});
