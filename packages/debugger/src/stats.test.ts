import { describe, expect, it } from "vitest";
import {
  STATS_COMMAND_INTERVAL_MS,
  TICK_BUDGET_MS,
  createMessageRateMeter,
  isTickOverBudget,
  shouldEmitStatsCommand,
  statsHudModel,
  type StatsHudModel,
} from "./stats";

describe("isTickOverBudget", () => {
  it("flags the combined script plus physics tick against the 8ms budget", () => {
    expect(TICK_BUDGET_MS).toBe(8);
    expect(isTickOverBudget(3, 2)).toBe(false);
    expect(isTickOverBudget(5, 4)).toBe(true);
  });
});

describe("shouldEmitStatsCommand", () => {
  it("emits the first sample then waits 200ms so the HUD stays near 5 Hz", () => {
    expect(STATS_COMMAND_INTERVAL_MS).toBe(200);
    expect(shouldEmitStatsCommand(0, null)).toBe(true);
    expect(shouldEmitStatsCommand(199, 0)).toBe(false);
    expect(shouldEmitStatsCommand(200, 0)).toBe(true);
    expect(shouldEmitStatsCommand(399, 200)).toBe(false);
    expect(shouldEmitStatsCommand(400, 200)).toBe(true);
  });
});

const rowText = (model: StatsHudModel) => Object.fromEntries(model.rows.map(({ group, metrics }) =>
  [group, metrics.map(({ label, text }) => label ? `${label} ${text}` : text)]));

describe("statsHudModel", () => {
  it("shows the bridge rate, live actors against snapshot capacity and the tick index under threads", () => {
    const model = statsHudModel(
      { fps: 60, scriptMs: 1, physicsMs: 1, bridgeMessagesPerSec: 42, liveActors: 300, snapshotCapacity: 512, ticks: 1200 },
      ["threads"],
    );
    expect(rowText(model)).toEqual({ threads: ["bridge 42/s", "actors 300/512", "ticks 1200"] });
  });

  it("lists enabled groups in display order and leaves a group empty when the host has nothing for it", () => {
    const model = statsHudModel({ fps: 0, scriptMs: 0, physicsMs: 0 }, ["threads", "memory", "unit", "draws"]);
    expect(model.rows.map((row) => row.group)).toEqual(["unit", "memory", "draws", "threads"]);
    expect(rowText(model)).toEqual({ unit: ["tick 0.00 / 8 ms"], memory: [], draws: [], threads: [] });
    expect(model.frame.map((metric) => metric.text)).toEqual(["— ms", "0.00 ms", "0.00 ms"]);
  });

  it("marks the tick timings and the Unit row over budget", () => {
    const model = statsHudModel({ fps: 50, scriptMs: 6, physicsMs: 3, publishMs: 0.5 }, ["unit"]);
    expect(model.overBudget).toBe(true);
    expect(model.frame.map(({ id, text, warn }) => ({ id, text, warn: warn === true }))).toEqual([
      { id: "frame-ms", text: "20.0 ms", warn: false },
      { id: "script-ms", text: "6.00 ms", warn: true },
      { id: "physics-ms", text: "3.00 ms", warn: true },
      { id: "over-budget", text: `over ${TICK_BUDGET_MS} ms budget`, warn: true },
    ]);
    expect(model.rows[0]!.metrics.map(({ text, warn }) => ({ text, warn: warn === true }))).toEqual([
      { text: "9.00 / 8 ms", warn: true },
      { text: "0.50 ms", warn: false },
    ]);
  });

  it("shows memory and render detail with the ceiling warnings the host reports", () => {
    const model = statsHudModel({
      fps: 60,
      scriptMs: 1,
      physicsMs: 1,
      memoryBytes: 512,
      jsHeapBytes: 3 * 1024 * 1024,
      geometryBytes: 2048,
      geometryHigh: true,
      draws: 900,
      drawsHigh: true,
      meshCount: 12,
      textureCount: 4,
      rendering: {
        cpuMs: 1.5, gpuMs: null, gpuStatus: "unsupported", width: 1280, height: 720, shadowDrawCalls: 6,
        readbackMs: null, autoLod: { meshes: 0, reduced: 0 }, qualityLimits: ["shadows off"],
      },
    }, ["memory", "draws"]);
    expect(rowText(model)).toEqual({
      memory: ["mem 512 B", "js 3.0 MB", "geo 2.0 KB"],
      draws: [
        "draws 900", "meshes 12", "tex 4", "cpu 1.50 ms", "gpu unsupported", "1280×720", "shadows 6 draws",
        "shadows off", "draws high", "geo high",
      ],
    });
    const warned = model.rows.flatMap((row) => row.metrics.filter((metric) => metric.warn).map((metric) => metric.id));
    expect(warned).toEqual(["geo", "draws", "quality-limits", "draw-warn", "geo-warn"]);
  });
});

describe("createMessageRateMeter", () => {
  it("reports messages per second over the last complete window", () => {
    let now = 0;
    const meter = createMessageRateMeter(() => now);
    for (let index = 0; index < 10; index++) meter.note();
    expect(meter.perSecond()).toBe(0);
    now = 250;
    expect(meter.perSecond()).toBe(40);
    now = 300;
    meter.note();
    expect(meter.perSecond()).toBe(40);
    now = 500;
    expect(meter.perSecond()).toBe(4);
  });
});
