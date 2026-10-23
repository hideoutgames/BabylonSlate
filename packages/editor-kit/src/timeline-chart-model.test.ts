import { describe, expect, it } from "vitest";
import {
  timelineBucket,
  timelineHit,
  timelineMarkerAt,
  timelinePeaks,
  timelineScale,
  timelineStep,
  timelineTotals,
  type TimelineTrack,
} from "./timeline-chart-model";

const track = (times: number[], ...segments: number[][]): TimelineTrack => ({
  id: "ticks",
  label: "Ticks",
  times,
  unit: "ms",
  segments: segments.map((values, index) => ({ label: `Part ${index}`, values, color: `--part-${index}` })),
});

describe("timeline chart geometry", () => {
  it("stacks each sample's parts, counting a missing part as nothing and a sample with none as missing", () => {
    expect([...timelineTotals(track([0, 1, 2], [1, NaN, NaN], [2, 3, NaN]))]).toEqual([3, 3, NaN]);
  });

  it("puts samples in buckets across the domain and keeps each bucket's slowest sample", () => {
    const times = [0, 10, 20, 35, 99, 100, 120];
    const totals = Float64Array.from([1, 5, 2, 4, 3, 8, 9]);
    expect(timelineBucket(100, [0, 100], 4)).toBe(3);
    expect(timelineBucket(-1, [0, 100], 4)).toBe(-1);
    expect([...timelinePeaks(times, totals, [0, 100], 4)]).toEqual([1, 3, -1, 5]);
  });

  it("scales a track to its budget or its tallest bar, with headroom", () => {
    const totals = Float64Array.from([2, 6]);
    expect(timelineScale(totals, Int32Array.from([0, 1]), 8)).toBeCloseTo(8.8);
    expect(timelineScale(totals, Int32Array.from([0, 1]))).toBeCloseTo(6.6);
    expect(timelineScale(new Float64Array(0), new Int32Array(0))).toBe(1);
  });

  it("hits the bar under the pointer, else the nearest within reach", () => {
    const peaks = Int32Array.from([-1, 4, -1, -1, -1, -1, 9]);
    expect(timelineHit(peaks, 1)).toBe(4);
    expect(timelineHit(peaks, 3)).toBe(4);
    expect(timelineHit(peaks, 5)).toBe(9);
    expect(timelineHit(peaks, 4, 1)).toBe(-1);
  });

  it("finds the marker under the pointer, with slack around a point", () => {
    const markers = [{ atMs: 10, endMs: 30, label: "Loading", color: "--a" }, { atMs: 50, label: "Scene Changed", color: "--b" }];
    expect(timelineMarkerAt(markers, 20, 1)?.label).toBe("Loading");
    expect(timelineMarkerAt(markers, 52, 3)?.label).toBe("Scene Changed");
    expect(timelineMarkerAt(markers, 40, 3)).toBeNull();
  });

  it("steps through a track and stops at its ends", () => {
    expect(timelineStep([0, 1, 2], 1, 1)).toBe(2);
    expect(timelineStep([0, 1, 2], 2, 1)).toBe(2);
    expect(timelineStep([0, 1, 2], 0, -1)).toBe(0);
  });
});
