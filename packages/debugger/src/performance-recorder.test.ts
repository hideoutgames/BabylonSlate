import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_TICK_COLUMNS,
  PERFORMANCE_TICK_COLUMNS_V1,
  PerformanceRecorder,
  parsePerformanceProfile,
  serializePerformanceProfile,
  summarizePerformanceColumn,
  summarizePerformanceColumns,
  type PerformanceIdentity,
  type PerformanceTickSample,
} from "./performance-recorder";

const identity: PerformanceIdentity = {
  sessionId: "session-1", mode: "play", sourceSha: "source", buildId: "test",
  sceneId: "world", backend: "webgl2", renderPath: "frameGraph",
  runtimeHost: "worker", quality: "Low", frameCap: 60, dynamicResolution: false,
  enabledDiagnostics: ["performance"], gpuTiming: "unavailable",
};
/** A tick whose unnamed timings are 0. */
const tick = (sample: Partial<PerformanceTickSample> & Pick<PerformanceTickSample, "tickId" | "elapsedMs">): PerformanceTickSample => ({
  scriptMs: 0, physicsMs: 0, publishMs: 0, otherMs: 0,
  gameInstanceMs: 0, sceneSubsystemsMs: 0, actorsMs: 0, componentsMs: 0, postPhysicsMs: 0, sceneSystemsMs: 0,
  ...sample,
});
const frame = (frameId: number, completedAtMs: number) => ({
  frameId, tickId: frameId, sceneGeneration: 1, completedAtMs,
  preparationMs: 1, submissionMs: 2, copyMs: 0.5, drawCalls: 5,
  width: 1280, height: 720, resolutionScale: 1,
});

describe("PerformanceRecorder", () => {
  it("keeps actual completed-frame intervals separate from tick populations", () => {
    let now = 1000;
    const recorder = new PerformanceRecorder({ now: () => now });
    recorder.start(identity);
    recorder.recordFrame(frame(1, 1005));
    recorder.recordFrame(frame(2, 1025));
    recorder.recordFrame(frame(4, 1065));
    recorder.recordTick(tick({ tickId: 1, elapsedMs: 0, scriptMs: 3, physicsMs: 2, publishMs: 1 }));
    now = 1100;
    const result = recorder.stop()!;
    expect(summarizePerformanceColumn(result.frames, "intervalMs", 16.67)).toEqual({
      count: 2, median: 30, p95: 40, p99: 40, maximum: 40, overBudgetCount: 2,
    });
    expect(summarizePerformanceColumn(result.ticks, "scriptMs", 8)).toMatchObject({ count: 1, median: 3, overBudgetCount: 0 });
    expect(result.durationMs).toBe(100);
    expect(result.frames.chunks[0]![0]).toBe(1);
    expect(result.frames.chunks[0]![3]).toBe(5);
  });

  it("stops at the finite deadline without accepting a late sample", () => {
    let now = 0;
    const stopped: string[] = [];
    const recorder = new PerformanceRecorder({ now: () => now, onStopped: (result) => stopped.push(result.stopReason) });
    recorder.start(identity);
    recorder.recordFrame(frame(1, 0));
    now = 10_000;
    expect(recorder.recordFrame(frame(2, now))).toBe(false);
    expect(recorder.recording).toBe(false);
    expect(recorder.stop()?.frames.count).toBe(1);
    expect(stopped).toEqual(["duration"]);
  });

  it("reports the combined script and physics budget per runtime tick", () => {
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start(identity);
    recorder.recordTick(tick({ tickId: 1, elapsedMs: 0, scriptMs: 6, physicsMs: 4, publishMs: 100 }));
    recorder.recordTick(tick({ tickId: 2, elapsedMs: 16, scriptMs: 2, physicsMs: 4, publishMs: 200 }));
    const result = recorder.stop()!;
    expect(summarizePerformanceColumns(result.ticks, ["scriptMs", "physicsMs"], 8)).toEqual({
      count: 2, median: 8, p95: 10, p99: 10, maximum: 10, overBudgetCount: 1,
    });
    expect(summarizePerformanceColumns(result.ticks, ["scriptMs", "missingMs"], 8).count).toBe(0);
  });

  it("bounds retained numeric allocations and stops before exceeding the budget", () => {
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start(identity, { byteBudget: 4096 });
    let accepted = 0;
    while (recorder.recordFrame(frame(accepted, accepted))) accepted++;
    const result = recorder.stop()!;
    expect(accepted).toBeGreaterThan(0);
    expect(result.frames.count).toBe(accepted);
    expect(result.retainedBytes).toBeLessThanOrEqual(4096);
    expect(result.stopReason).toBe("budget");
    expect(result.droppedRecords).toBe(1);
    expect(recorder.recordFrame(frame(1000, 1000))).toBe(false);
    expect(result.droppedRecords).toBe(1);
  });

  it("counts a drained tick stamped past the recording window as dropped", () => {
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start(identity, { durationMs: 1000 });
    const late = tick({ tickId: 1, elapsedMs: 999, scriptMs: 1, physicsMs: 1 });
    expect(recorder.recordTick(late, { drain: true })).toBe(true);
    expect(recorder.recordTick({ ...late, tickId: 2, elapsedMs: 1001 }, { drain: true })).toBe(false);
    const result = recorder.stop()!;
    expect(result.ticks.count).toBe(1);
    expect(result.droppedRecords).toBe(1);
  });

  it("rejects Simulation and overlapping starts without replacing live data", () => {
    const recorder = new PerformanceRecorder();
    expect(() => recorder.start({ ...identity, mode: "simulate" })).toThrow("Use Play or Preview Build");
    recorder.start(identity);
    expect(() => recorder.start(identity)).toThrow("already active");
    expect(() => recorder.recordTick(tick({ tickId: 1, elapsedMs: 0, scriptMs: NaN }))).toThrow("finite");
    expect(() => recorder.recordTick(tick({ tickId: 1, elapsedMs: 0, actorsMs: Infinity }))).toThrow("finite");
    expect(recorder.stop()?.ticks.count).toBe(0);
  });

  it("round-trips explicit versioned export, including absent first intervals", () => {
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start(identity);
    recorder.recordFrame(frame(1, 0));
    const result = recorder.stop()!;
    const json = serializePerformanceProfile(result);
    const reopened = parsePerformanceProfile(JSON.parse(json));
    expect(reopened?.identity).toEqual(identity);
    expect(reopened?.frames.count).toBe(1);
    expect(summarizePerformanceColumn(reopened!.frames, "intervalMs", 16.67).count).toBe(0);
    expect(parsePerformanceProfile({ ...JSON.parse(json), version: 99 })).toBeNull();
    expect(parsePerformanceProfile({ ...JSON.parse(json), frames: { ...JSON.parse(json).frames, count: 100 } })).toBeNull();
  });

  it("records every tick phase as version 2, and opens it again", () => {
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start(identity);
    recorder.recordTick(tick({ tickId: 1, elapsedMs: 0, scriptMs: 3, physicsMs: 2, actorsMs: 1.25, sceneSystemsMs: 0.75 }));
    const reopened = parsePerformanceProfile(JSON.parse(serializePerformanceProfile(recorder.stop()!)));
    expect(reopened?.version).toBe(2);
    expect(reopened?.ticks.columns).toEqual(PERFORMANCE_TICK_COLUMNS);
    expect(summarizePerformanceColumn(reopened!.ticks, "actorsMs").median).toBe(1.25);
    expect(summarizePerformanceColumn(reopened!.ticks, "sceneSystemsMs").median).toBe(0.75);
    // Version 2 tick rows are the full width; version 1 rows under a version 2 label are not.
    const json = JSON.parse(serializePerformanceProfile(reopened!));
    expect(parsePerformanceProfile({ ...json, ticks: { ...json.ticks, columns: [...PERFORMANCE_TICK_COLUMNS_V1] } })).toBeNull();
  });

  it("opens a version 1 profile with its script and physics split, and exports it as it was", () => {
    const golden = JSON.parse(readFileSync(new URL("./__fixtures__/profile-v1.golden.json", import.meta.url), "utf8"));
    const opened = parsePerformanceProfile(golden);
    expect(opened?.version).toBe(1);
    expect(opened?.ticks.columns).toEqual(PERFORMANCE_TICK_COLUMNS_V1);
    expect(summarizePerformanceColumn(opened!.ticks, "scriptMs").median).toBe(4);
    // No phase is invented for a version 1 tick.
    expect(summarizePerformanceColumn(opened!.ticks, "actorsMs").count).toBe(0);
    const reopened = parsePerformanceProfile(JSON.parse(serializePerformanceProfile(opened!)));
    expect(reopened).toEqual(opened);
  });

  it("retains a separate bounded valid-query population without repeating stale GPU results", () => {
    const recorder = new PerformanceRecorder({ now: () => 1000 });
    recorder.start({ ...identity, gpuTiming: "unpaired", gpuAttribution: "engine-aggregate" }, { byteBudget: 4096 });
    const sample = { observedAtMs: 1010, durationMs: 2.5, querySequence: 40, coalescedQueries: 0, attribution: "engine-aggregate" as const };
    expect(recorder.recordGpu(sample)).toBe(true);
    expect(recorder.recordGpu(sample)).toBe(false);
    let querySequence = 41;
    while (recorder.recordGpu({ ...sample, querySequence: querySequence++ })) { /* Fill only the admitted numeric budget. */ }
    const result = recorder.stop()!;
    expect(result.stopReason).toBe("budget");
    expect(result.retainedBytes).toBeLessThanOrEqual(result.byteBudget);
    expect(result.frames.count).toBe(0);
    expect(result.ticks.count).toBe(0);
    expect(result.gpu.chunks[0]![0]).toBe(10);
    const reopened = parsePerformanceProfile(JSON.parse(serializePerformanceProfile(result)))!;
    expect(reopened.gpu.count).toBe(result.gpu.count);
    expect(summarizePerformanceColumn(reopened.gpu, "durationMs")).toMatchObject({ count: result.gpu.count, median: 2.5 });
    expect(parsePerformanceProfile({ ...reopened, identity: { ...reopened.identity, gpuTiming: "disabled" } })).toBeNull();
  });
});
