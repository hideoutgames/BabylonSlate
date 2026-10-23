import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_FRAME_COLUMNS,
  PERFORMANCE_LONG_TASK_COLUMNS,
  PERFORMANCE_MEMORY_COLUMNS,
  PERFORMANCE_TICK_COLUMNS_V1,
  type PerformanceProfile,
  type PerformanceStream,
} from "@haptic/debugger";
import { accountedMemoryMiB, linkedRow, profileMarkers, streamColumn, summarizeRange, tickTimes } from "./performance-timeline-model";

const stream = (columns: readonly string[], rows: Record<string, number>[]): PerformanceStream => ({
  columns,
  count: rows.length,
  chunks: [Float64Array.from(rows.flatMap((row) => columns.map((column) => row[column] ?? 0)))],
});
const frame = (tickId: number, completedAtMs: number, extra: Record<string, number> = {}) =>
  ({ tickId, completedAtMs, intervalMs: 16, sceneGeneration: 1, loading: 0, ...extra });
const tick = (tickId: number, elapsedMs: number, scriptMs = 1) => ({ tickId, elapsedMs, scriptMs, physicsMs: 2 });

function profile(frames: Record<string, number>[], ticks: Record<string, number>[], longTasks: Record<string, number>[] = []): PerformanceProfile {
  return {
    frames: stream(PERFORMANCE_FRAME_COLUMNS, frames),
    ticks: stream(PERFORMANCE_TICK_COLUMNS_V1, ticks),
    gpu: { columns: [], count: 0, chunks: [] },
    memory: { columns: PERFORMANCE_MEMORY_COLUMNS, count: 0, chunks: [] },
    longTasks: stream(PERFORMANCE_LONG_TASK_COLUMNS, longTasks),
  } as unknown as PerformanceProfile;
}

describe("performance timeline model", () => {
  it("places ticks on the frames' clock by the median gap to the frames presenting them", () => {
    // Tick 4 is never presented; one frame is late, which the median ignores.
    const recording = profile(
      [frame(1, 21), frame(2, 37), frame(3, 60)],
      [tick(1, 0), tick(2, 16), tick(3, 32), tick(4, 48)],
    );
    expect([...tickTimes(recording)]).toEqual([21, 37, 53, 69]);
    expect([...tickTimes(profile([], [tick(1, 0), tick(2, 16)]))]).toEqual([0, 16]);
  });

  it("links a frame to the tick it presents, and a tick to the first frame presenting it", () => {
    const recording = profile([frame(1, 21), frame(1, 37), frame(3, 60)], [tick(1, 0), tick(2, 16), tick(3, 32)]);
    expect(linkedRow(recording.frames, recording.ticks, 2)).toBe(2);
    expect(linkedRow(recording.ticks, recording.frames, 0)).toBe(0);
    expect(linkedRow(recording.ticks, recording.frames, 1)).toBeNull();
  });

  it("marks loading screens as spans and scene changes as points", () => {
    const recording = profile([
      frame(1, 16),
      frame(2, 32, { loading: 1 }),
      frame(3, 48, { loading: 1 }),
      frame(4, 64, { sceneGeneration: 2 }),
    ], []);
    expect(profileMarkers(recording)).toEqual([
      { atMs: 16, endMs: 48, label: "Loading", color: "--muted-foreground" },
      { atMs: 64, label: "Scene Changed", color: "--foreground" },
    ]);
  });

  it("marks long tasks as spans named by their length, in time order with the other markers", () => {
    const recording = profile(
      [frame(1, 16), frame(2, 32, { loading: 1 }), frame(3, 48)],
      [],
      [{ startedAtMs: 40, durationMs: 120.4 }, { startedAtMs: 5, durationMs: 55 }],
    );
    expect(profileMarkers(recording)).toEqual([
      { atMs: 5, endMs: 60, label: "Long Task 55 ms", color: "--warning" },
      { atMs: 16, endMs: 32, label: "Loading", color: "--muted-foreground" },
      { atMs: 40, endMs: 160.4, label: "Long Task 120 ms", color: "--warning" },
    ]);
  });

  it("adds each memory sample's accounted textures and geometry, in MiB", () => {
    const memory = stream(PERFORMANCE_MEMORY_COLUMNS, [
      { sampledAtMs: 0, textureBytes: 3 * 1024 * 1024, geometryBytes: 1024 * 1024 },
      { sampledAtMs: 200, textureBytes: 512 * 1024, geometryBytes: 0 },
    ]);
    expect([...accountedMemoryMiB(memory)]).toEqual([4, 0.5]);
  });

  it("summarizes only the samples in a range, as the Summary does", () => {
    const recording = profile([], [tick(1, 0, 1), tick(2, 16, 9), tick(3, 32, 3), tick(4, 48, 20)]);
    const times = streamColumn(recording.ticks, "elapsedMs");
    expect(summarizeRange(recording.ticks, times, [10, 40], ["scriptMs", "physicsMs"], 8)).toMatchObject({
      count: 2, median: 8, maximum: 11, overBudgetCount: 1,
    });
  });
});
