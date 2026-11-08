import { describe, expect, it } from "vitest";
import {
  KEYFRAME_TIMELINE_END_GUTTER_PX,
  KEYFRAME_TIMELINE_GUTTER_PX,
  fitKeyframeView,
  keyAt,
  keyRefFromId,
  keyRefId,
  keyframeScrollHit,
  keyframeScrollRange,
  keyframeScrollThumb,
  keysInRect,
  panKeyframeView,
  resizeKeyframeView,
  rulerTicks,
  scrollKeyframeView,
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
    expect(timeToX(view, 8)).toBeCloseTo(820 - KEYFRAME_TIMELINE_END_GUTTER_PX);
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

describe("keyframe timeline scroll bar", () => {
  // 400 px of lanes from 1 s at 200 px per second show 1 s to 3 s of a 4 s clip. The range runs from the
  // gutter before 0 s (10 px, 0.05 s) to the gutter after the end (24 px, 0.12 s): 4.17 s on a 417 px
  // track, 0.01 s per pixel. The thumb is 2 / 4.17 of the track, and 1.05 of the 2.17 s it can travel along.
  const view = { start: 1, pixelsPerSecond: 200 };
  const range = { start: -0.05, end: 4.12 };
  const thumb = { left: 105, width: 200 };

  it("spans the clip and its gutters, and wherever the view has gone past them", () => {
    const spanned = keyframeScrollRange(view, 400, 4);
    expect(spanned.start).toBeCloseTo(-0.05);
    expect(spanned.end).toBeCloseTo(4.12);
    // Panned past the clip's end: the range reaches the view's end, 5 s to 7 s.
    expect(keyframeScrollRange({ start: 5, pixelsPerSecond: 200 }, 400, 4).end).toBeCloseTo(7);
  });

  it("sizes the thumb by the share of the range shown, never below its minimum", () => {
    const sized = keyframeScrollThumb(view, 400, range, 417, 24);
    expect(sized.left).toBeCloseTo(105);
    expect(sized.width).toBeCloseTo(200);
    // Fitted: the thumb fills the track.
    expect(keyframeScrollThumb({ start: -0.05, pixelsPerSecond: 200 }, 834, { start: -0.05, end: 4.12 }, 417, 24)).toEqual({ left: 0, width: 417 });
    // 0.1 s of the 4.17 s would be 10 px; shown at the range's end, the thumb ends the track.
    const narrow = keyframeScrollThumb({ start: 4.02, pixelsPerSecond: 4000 }, 400, range, 417, 24);
    expect(narrow.width).toBe(24);
    expect(narrow.left).toBeCloseTo(393);
  });

  it("pans by the thumb's drag, within the range", () => {
    expect(scrollKeyframeView(view, 400, range, 417, thumb, 50)).toEqual({ start: expect.closeTo(1.5), pixelsPerSecond: 200 });
    expect(scrollKeyframeView(view, 400, range, 417, thumb, 500).start).toBeCloseTo(2.12);
    expect(scrollKeyframeView(view, 400, range, 417, thumb, -500).start).toBeCloseTo(-0.05);
  });

  it("zooms by an end's drag, keeping the other end's time", () => {
    const resize = (edge: "start" | "end", dx: number) => {
      const next = resizeKeyframeView(view, 400, range, 417, edge, dx);
      return [Number(next.start.toFixed(4)), Number(next.pixelsPerSecond.toFixed(2))];
    };
    // The end 1 s earlier: 1 s to 2 s.
    expect(resize("end", -100)).toEqual([1, 400]);
    expect(resize("end", 100)).toEqual([1, 133.33]);
    // The start 0.5 s later: 1.5 s to 3 s.
    expect(resize("start", 50)).toEqual([1.5, 266.67]);
    // The start stops at the gutter before 0 s: 3.0769 s shown at 130 px per second, from -10 / 130 s.
    expect(resize("start", -200)).toEqual([-0.0769, 130]);
    // Never closer than 4000 px per second.
    expect(resize("end", -300)).toEqual([1, 4000]);
  });

  it("resizes from a thumb's ends and drags from its middle", () => {
    expect([100, 108, 200, 302, 306].map((x) => keyframeScrollHit(thumb, x, 6))).toEqual(["track", "start", "thumb", "end", "track"]);
    // A narrow thumb keeps a middle third to drag.
    expect([7, 12, 17].map((x) => keyframeScrollHit({ left: 0, width: 24 }, x, 22))).toEqual(["start", "thumb", "end"]);
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
