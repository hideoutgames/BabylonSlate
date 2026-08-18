import { describe, expect, it } from "vitest";
import { TICK_BUDGET_MS } from "@babylonslate/debugger";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  readSnapshotHeader,
  snapshotFloatCount,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("P14 perf smoke", () => {
  it("keeps a tiny scene's script and physics tick under 8ms", () => {
    const runtime = createInProcessRuntime({
      seed: 14,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const actor = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "dynamic", mass: 1, gravityScale: 1 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
      }),
    );
    world.spawnActorNow(actor);
    runtime.start();
    for (let i = 0; i < 30; i++) runtime.tick();
    expect(runtime.lastScriptMs).toBeLessThan(TICK_BUDGET_MS);
    expect(runtime.lastPhysicsMs).toBeLessThan(TICK_BUDGET_MS);
    expect(runtime.lastScriptMs + runtime.lastPhysicsMs).toBeLessThan(
      TICK_BUDGET_MS,
    );
    runtime.stop();
  });

  it("posts stats near 5 Hz while snapshot tickIndex stays per tick", () => {
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
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    expect(readSnapshotHeader(buf).tickIndex).toBe(120);
    runtime.stop();
  });

  it("keeps a looping AudioComponent at one playSound across 2000 ticks", () => {
    const commands: CommandMessage[] = [];
    const costs: number[] = [];
    const runtime = createInProcessRuntime({
      seed: 14,
      maxActors: 8,
      preferSoftwarePhysics: true,
      seedDemoActors: false,
      playScene: {
        name: "Bed",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("speaker", "Speaker", {
            components: [
              {
                id: "audio-1",
                classId: "AudioComponent",
                properties: {
                  audioAssetGuid: "bed",
                  playOnStart: true,
                  loop: true,
                  volume: 1,
                },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 2000; i++) {
      runtime.tick();
      costs.push(runtime.lastScriptMs + runtime.lastPhysicsMs);
    }
    const stats = commands.filter((command) => command.type === "stats");
    expect(
      commands.filter((command) => command.type === "playSound"),
    ).toHaveLength(1);
    expect(stats.length).toBeGreaterThanOrEqual(1);
    expect(stats.length).toBeLessThanOrEqual(40);
    const first = median(costs.slice(0, 100));
    const last = median(costs.slice(-100));
    expect(last).toBeLessThanOrEqual(Math.max(first * 8, 2));
    expect(last).toBeLessThan(TICK_BUDGET_MS);
    runtime.stop();
  });
});
