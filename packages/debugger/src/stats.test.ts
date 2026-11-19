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

  it("splits the Unit row into the tick's timed phases when the host reports them", () => {
    const phaseMs = [0.1, 0.2, 1.5, 0.5, 0.25, 2, 0.3, 0.4, 0.05];
    const row = (input: Parameters<typeof statsHudModel>[0]) =>
      statsHudModel(input, ["unit"]).rows[0]!.metrics.map(({ label, text }) => `${label} ${text}`);
    expect(row({ fps: 60, scriptMs: 3, physicsMs: 2, publishMs: 0.5, phaseMs })).toEqual([
      "tick 5.00 / 8 ms",
      "game 0.10 ms", "subsystems 0.20 ms", "actors 1.50 ms", "components 0.50 ms", "objects 0.25 ms",
      "physics 2.00 ms", "post-physics 0.30 ms", "systems 0.40 ms", "gc 0.05 ms",
      "publish 0.50 ms",
    ]);
    // A host without the split (or an incomplete one) keeps the total.
    expect(row({ fps: 60, scriptMs: 3, physicsMs: 2, publishMs: 0.5, phaseMs: [1, 2] })).toEqual(["tick 5.00 / 8 ms", "publish 0.50 ms"]);
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

  it("shows created objects and the last collection pass under memory", () => {
    const row = (input: Partial<Parameters<typeof statsHudModel>[0]>) =>
      rowText(statsHudModel({ fps: 60, scriptMs: 1, physicsMs: 1, ...input }, ["memory"])).memory;
    expect(row({ collectableObjects: 12, garbageCollectionMs: 0.125 })).toEqual(["objects 12", "gc 0.13 ms"]);
    // Before the first pass the host sends only the count.
    expect(row({ collectableObjects: 0 })).toEqual(["objects 0"]);
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
        occlusion: { tested: 40, culled: 25, triangles: 60, ms: 0.42 },
        firstDraws: { draws: 7, loadCompiled: 5, stalls: 2, worstFrameMs: 180.4 },
        // Passes that drew nothing in the frame are left out.
        drawPasses: { objects: 640, geometry: 0, shadows: 6, captures: 210, post: 44, other: 0 },
      },
    }, ["memory", "draws"]);
    expect(rowText(model)).toEqual({
      memory: ["mem 512 B", "js 3.0 MB", "geo 2.0 KB"],
      draws: [
        "draws 900", "meshes 12", "tex 4", "cpu 1.50 ms", "gpu unsupported", "1280×720", "shadows 6 draws",
        "passes objects 640 · shadows 6 · captures 210 · post 44",
        "occlusion culled 25/40 · 60 tris · 0.42 ms", "first draws 7 (5 load) · worst 180 ms", "shadows off", "draws high", "geo high",
      ],
    });
    const warned = model.rows.flatMap((row) => row.metrics.filter((metric) => metric.warn).map((metric) => metric.id));
    expect(warned).toEqual(["geo", "draws", "first-draws", "quality-limits", "draw-warn", "geo-warn"]);
  });

  it("says when occlusion culling is idle, backing off while its runs cull nothing, and how often it runs", () => {
    const rendering = {
      cpuMs: 1, gpuMs: null, gpuStatus: "unsupported", width: 8, height: 8, shadowDrawCalls: 0,
      readbackMs: null, autoLod: { meshes: 0, reduced: 0 }, qualityLimits: [],
    };
    type Occlusion = { tested: number; culled: number; triangles: number; ms: number; idle: boolean; backOff: number };
    const occlusion = (value: Occlusion) => statsHudModel({ fps: 60, scriptMs: 0, physicsMs: 0, rendering: { ...rendering, occlusion: value } }, ["draws"])
      .rows[0]!.metrics.find((metric) => metric.id === "occlusion");
    expect(occlusion({ tested: 280, culled: 0, triangles: 156, ms: 0, idle: true, backOff: 32 }))
      .toMatchObject({ label: "occlusion culled", text: "0/280 · 156 tris · 0.00 ms · idle, runs 1 in 33" });
    expect(occlusion({ tested: 88, culled: 5, triangles: 120, ms: 0.31, idle: false, backOff: 0 })).toMatchObject({ text: "5/88 · 120 tris · 0.31 ms" });
  });

  it("shows the render cpu as the mean of the last frames where the host has one", () => {
    const rendering = {
      cpuMs: 1, gpuMs: null, gpuStatus: "unsupported", width: 8, height: 8, shadowDrawCalls: 0,
      readbackMs: null, autoLod: { meshes: 0, reduced: 0 }, qualityLimits: [],
    };
    const cpu = (extra: object) => statsHudModel({ fps: 60, scriptMs: 0, physicsMs: 0, rendering: { ...rendering, ...extra } }, ["draws"])
      .rows[0]!.metrics.find((metric) => metric.id === "cpu");
    // A whole-millisecond clock read the last frame as 1 ms; the frames before it average 0.35 ms.
    expect(cpu({ cpuMeanMs: 0.35 })).toMatchObject({ text: "0.35 ms", raw: 0.35 });
    expect(cpu({ cpuMeanMs: null })).toMatchObject({ text: "1.00 ms", raw: 1 });
    expect(cpu({})).toMatchObject({ text: "1.00 ms", raw: 1 });
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
