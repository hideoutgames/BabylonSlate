import { describe, expect, it } from "vitest";
import {
  PerformanceRecorder,
  parsePerformanceProfile,
  serializePerformanceProfile,
  summarizePerformanceColumn,
  type PerformanceIdentity,
} from "./performance-recorder";

const identity: PerformanceIdentity = {
  sessionId: "session-1", mode: "play", sourceSha: "source", buildId: "test",
  sceneId: "world", backend: "webgl2", renderPath: "frameGraph",
  runtimeHost: "worker", quality: "Low", frameCap: 60, dynamicResolution: false,
  enabledDiagnostics: ["performance"], gpuTiming: "unavailable",
};
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
    recorder.recordTick({ tickId: 1, elapsedMs: 0, scriptMs: 3, physicsMs: 2, publishMs: 1, otherMs: 0 });
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

  it("rejects Simulation and overlapping starts without replacing live data", () => {
    const recorder = new PerformanceRecorder();
    expect(() => recorder.start({ ...identity, mode: "simulate" })).toThrow("Use Play or Preview Build");
    recorder.start(identity);
    expect(() => recorder.start(identity)).toThrow("already active");
    expect(() => recorder.recordTick({ tickId: 1, elapsedMs: 0, scriptMs: NaN, physicsMs: 0, publishMs: 0, otherMs: 0 })).toThrow("finite");
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
});
