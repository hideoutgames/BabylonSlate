import { describe, expect, it } from "vitest";
import {
  KEYFRAME_TIMELINE_GUTTER_PX,
  fitKeyframeView,
  keyAt,
  keyRefFromId,
  keyRefId,
  keysInRect,
  panKeyframeView,
  rulerTicks,
  snapToFrame,
  timeToX,
  xToTime,
  zoomKeyframeView,
  type KeyframeTimelineRow,
} from "./keyframe-timeline-model";

const row = (id: string, times: number[]): KeyframeTimelineRow =>
  ({ id, kind: "track", keys: times.map((time, index) => ({ id: `${id}-${index}`, time, shape: "diamond" })) });

describe("keyframe timeline view", () => {
  it("fits 0 s to the clip's end inside the gutters", () => {
    const view = fitKeyframeView(8, 820);
    expect(timeToX(view, 0)).toBeCloseTo(KEYFRAME_TIMELINE_GUTTER_PX);
    expect(timeToX(view, 8)).toBeCloseTo(820 - KEYFRAME_TIMELINE_GUTTER_PX);
    expect(xToTime(view, timeToX(view, 3.25))).toBeCloseTo(3.25);
  });

  it("zooms about the anchor and never pans before the gutter", () => {
    const view = fitKeyframeView(10, 1020);
    const anchorX = timeToX(view, 4);
    const zoomed = zoomKeyframeView(view, 2, anchorX);
    expect(zoomed.pixelsPerSecond).toBeCloseTo(view.pixelsPerSecond * 2);
    expect(xToTime(zoomed, anchorX)).toBeCloseTo(4);
    expect(timeToX(panKeyframeView(zoomed, 5000), 0)).toBeCloseTo(KEYFRAME_TIMELINE_GUTTER_PX);
  });
});

describe("snapToFrame", () => {
  it("rounds to the nearest frame within the clip", () => {
    expect(snapToFrame(1.51, 30, 8)).toBeCloseTo(1.5);
    expect(snapToFrame(0.03, 24, 8)).toBeCloseTo(1 / 24);
    expect(snapToFrame(0.02, 24, 8)).toBe(0);
    expect(snapToFrame(-1, 30, 8)).toBe(0);
    expect(snapToFrame(9, 30, 8)).toBe(8);
  });
});

describe("rulerTicks", () => {
  it("labels whole seconds when the clip fits and keeps labels apart", () => {
    const view = fitKeyframeView(8, 500);
    const labels = rulerTicks(view, 500, 30).filter((tick) => tick.label);
    expect(labels[0]).toEqual({ time: 0, label: "0s" });
    const spacing = timeToX(view, labels[1]!.time) - timeToX(view, labels[0]!.time);
    expect(spacing).toBeGreaterThanOrEqual(56);
    expect(labels.every((tick) => Number.isInteger(tick.time))).toBe(true);
  });

  it("labels frames when zoomed in, with one minor tick per frame", () => {
    const view = { start: 0, pixelsPerSecond: 3000 };
    const ticks = rulerTicks(view, 600, 30);
    const labels = ticks.filter((tick) => tick.label);
    expect(labels.map((tick) => tick.label).slice(0, 3)).toEqual(["0.00s", "0.03s", "0.07s"]);
    expect(ticks.length).toBe(labels.length);
  });
});

describe("key hits", () => {
  const view = { start: 0, pixelsPerSecond: 100 };

  it("finds the nearest key within reach", () => {
    const lane = row("a", [1, 1.1, 3]);
    expect(keyAt(lane, view, 104, 6)?.id).toBe("a-0");
    expect(keyAt(lane, view, 109, 6)?.id).toBe("a-1");
    expect(keyAt(lane, view, 200, 6)).toBeUndefined();
    expect(keyAt(lane, view, 214, 14)).toBeUndefined();
    expect(keyAt(undefined, view, 100, 6)).toBeUndefined();
  });

  it("selects keys whose centre is inside a marquee", () => {
    const rows = [row("a", [0.5, 2]), row("b", [1, 3]), row("c", [1.5])];
    // Rows are 24 px tall: the marquee crosses the centres of rows a and b only.
    const refs = keysInRect(rows, 24, view, { left: 40, right: 160, top: 5, bottom: 40 });
    expect(refs).toEqual([{ rowId: "a", keyId: "a-0" }, { rowId: "b", keyId: "b-0" }]);
  });

  it("round-trips key ref ids", () => {
    const ref = { rowId: "track/1", keyId: "key:2" };
    expect(keyRefFromId(keyRefId(ref))).toEqual(ref);
  });
});
