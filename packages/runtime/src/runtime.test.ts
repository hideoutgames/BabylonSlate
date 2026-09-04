import { describe, expect, it } from "vitest";
import { parseStackFrames, lookupAnchor, type AnchorEntry } from "./stack-map";
import { LogRingBuffer } from "./log-ring";
import { loadCompiledModule } from "./module-loader";
import { createInProcessRuntime } from "./driver";
import { readSnapshotHeader, snapshotFloatCount } from "@babylonslate/bridge";

describe("stack parser", () => {
  it("parses V8 and WebKit frames", () => {
    const v8 = parseStackFrames(
      "Error: boom\n    at foo (babylonslate:///abc.js:10:5)\n    at bar (file:///other.js:1:1)",
    );
    expect(v8[0]).toMatchObject({
      url: "babylonslate:///abc.js",
      line: 10,
      column: 5,
    });
    const webkit = parseStackFrames(
      "foo@babylonslate:///abc.js:12:3\nbar@native",
    );
    expect(webkit[0]).toMatchObject({
      url: "babylonslate:///abc.js",
      line: 12,
      column: 3,
    });
  });

  it("looks up the nearest preceding anchor", () => {
    const anchors: AnchorEntry[] = [
      { line: 1, column: 0, assetGuid: "a", graphId: "g", nodeId: "n1" },
      { line: 10, column: 0, assetGuid: "a", graphId: "g", nodeId: "n2" },
      { line: 20, column: 0, assetGuid: "a", graphId: "g", nodeId: "n3" },
    ];
    expect(lookupAnchor(anchors, 15, 0)?.nodeId).toBe("n2");
    expect(lookupAnchor(anchors, 1, 0)?.nodeId).toBe("n1");
    expect(lookupAnchor(anchors, 0, 0)).toBeNull();
  });
});

describe("log ring", () => {
  it("caps entries and preserves newest", () => {
    const ring = new LogRingBuffer(2);
    ring.push({
      severity: "log",
      category: "test",
      message: "a",
      frameId: 1,
    });
    ring.push({
      severity: "log",
      category: "test",
      message: "b",
      frameId: 2,
    });
    ring.push({
      severity: "error",
      category: "test",
      message: "c",
      frameId: 3,
    });
    expect(ring.entries().map((e) => e.message)).toEqual(["b", "c"]);
  });
});

describe("module loader", () => {
  it("evaluates a fixture module via Function fallback", async () => {
    const source = `
      export function run() { return 41 + 1; }
      //# sourceURL=babylonslate:///fixture.js
    `;
    const mod = await loadCompiledModule(source, "fixture");
    expect(mod.run?.()).toBe(42);
  });
});

describe("in-process runtime driver", () => {
  async function createBulkRuntime(
    onCommand?: Parameters<typeof createInProcessRuntime>[0]["onCommand"],
  ) {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand,
    });
    await runtime.loadScripts([
      {
        assetGuid: "bulk-script",
        classId: "BulkActor",
        source: "const noop = true;",
        anchors: [],
        entryPoints: [],
      },
    ]);
    return runtime;
  }

  it("grows through multiple generations for more than 256 live Actors", async () => {
    const commands: import("@babylonslate/bridge").CommandMessage[] = [];
    const runtime = await createBulkRuntime((command) =>
      commands.push(command),
    );
    for (let i = 0; i < 600; i++) {
      expect(
        runtime.spawnScriptedActor({ classId: "BulkActor" }),
      ).not.toBeNull();
    }
    expect(runtime.snapshotCapacity).toBe(1024);
    expect(runtime.snapshotGeneration).toBe(2);
    expect(
      commands.filter((command) => command.type === "snapshotLayout"),
    ).toEqual([
      { type: "snapshotLayout", capacity: 512, generation: 1 },
      { type: "snapshotLayout", capacity: 1024, generation: 2 },
    ]);
    runtime.start();
    runtime.tick();
    const snapshot = new Float32Array(snapshotFloatCount(1024));
    expect(runtime.copySnapshot(snapshot)).toBe(true);
    expect(readSnapshotHeader(snapshot)).toMatchObject({
      actorCount: 600,
      layoutGeneration: 2,
    });
    runtime.stop();
  });

  it("recycles slots across more than 256 cumulative spawns", async () => {
    const runtime = await createBulkRuntime();
    runtime.start();
    for (let i = 0; i < 300; i++) {
      const actor = runtime.spawnScriptedActor({ classId: "BulkActor" });
      expect(actor).not.toBeNull();
      runtime.getWorld().destroyActor(actor!.guid);
      runtime.tick();
    }
    expect(runtime.snapshotCapacity).toBe(256);
    expect(runtime.snapshotGeneration).toBe(0);
    runtime.stop();
  });

  it("ticks a world and writes snapshot headers", () => {
    const runtime = createInProcessRuntime({
      seed: 7,
      maxActors: 8,
      dt: 1 / 60,
    });
    runtime.start();
    for (let i = 0; i < 5; i++) {
      runtime.tick();
    }
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    const header = readSnapshotHeader(buf);
    expect(header.tickIndex).toBe(5);
    expect(header.actorCount).toBeGreaterThan(0);
    runtime.stop();
  });

  it("does not copy a snapshot before the first published tick", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
    });
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(false);
    runtime.stop();
  });

  it("resolves mapped actions and axes into TickContext", () => {
    const held: boolean[] = [];
    const runtime = createInProcessRuntime({ seed: 1, maxActors: 4 });
    const world = runtime.getWorld();
    const probe = world.createActor({
      classId: "Actor",
      hooks: {
        onTick: (_self, ctx) => {
          held.push(ctx.isActionHeld?.("Jump") ?? false);
        },
      },
    });
    world.spawnActorNow(probe);
    runtime.start();
    runtime.pushInput([{ kind: "key", tick: 0, code: "Space", phase: "down" }]);
    runtime.tick();
    expect(runtime.getResolvedInput().actions.Jump?.pressed).toBe(true);
    expect(held.at(-1)).toBe(true);
    runtime.pushInput([
      {
        kind: "gamepad",
        tick: 1,
        gamepadIndex: 0,
        axes: [0.9, 0, 0, 0],
        buttons: [],
      },
    ]);
    runtime.tick();
    expect(runtime.getResolvedInput().axes2D.Move!.x).toBeGreaterThan(0.5);
    runtime.stop();
  });

  it("exposes primary pointer XY on TickContext.getCursorPosition", () => {
    const samples: Array<
      { x: number; y: number; pressed: boolean } | undefined
    > = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const probe = world.createActor({
      classId: "Actor",
      hooks: {
        onTick: (_self, ctx) => {
          samples.push(ctx.getCursorPosition?.());
        },
      },
    });
    world.spawnActorNow(probe);
    runtime.start();
    runtime.pushInput([
      {
        kind: "pointer",
        tick: 0,
        pointerId: 1,
        phase: "down",
        x: 80,
        y: 24,
        button: 0,
      },
    ]);
    runtime.tick();
    expect(runtime.getResolvedInput().cursor).toEqual({
      x: 80,
      y: 24,
      pressed: true,
    });
    expect(samples.at(-1)).toEqual({ x: 80, y: 24, pressed: true });
    runtime.stop();
  });

  it("applies live gamepad events stamped with a host wall-clock tick", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
    });
    runtime.start();
    // Play's worker path stamps events with Math.floor(performance.now() / (1000/60)),
    // which is thousands while World.clock.tickIndex is still in the single digits.
    runtime.pushInput([
      {
        kind: "gamepad",
        tick: 50_000,
        gamepadIndex: 0,
        axes: [0.85, 0, 0, 0],
        buttons: [0, 0, 0, 0],
      },
    ]);
    runtime.tick();
    expect(runtime.getResolvedInput().axes2D.Move!.x).toBeGreaterThan(0.5);
    runtime.stop();
  });
});
