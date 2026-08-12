import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAG_ARM_MS } from "@babylonslate/editor-kit";
import {
  MARQUEE_FALLBACK_HEIGHT,
  MARQUEE_FALLBACK_WIDTH,
  attachGraphPaneMarquee,
  nodesIntersectingMarquee,
  resolvePaneMarqueePhase,
  type MarqueeNode,
  type ScreenRect,
} from "./graph-marquee";

const node = (
  id: string,
  x: number,
  y: number,
  size?: { width: number; height: number },
): MarqueeNode => ({
  id,
  position: { x, y },
  ...size,
});

describe("resolvePaneMarqueePhase", () => {
  it("stays pending while the pointer is still before the arm delay", () => {
    expect(
      resolvePaneMarqueePhase({ elapsedMs: DRAG_ARM_MS - 1, moved: false }),
    ).toBe("pending");
  });

  it("becomes pan if the pointer moves before the arm delay", () => {
    expect(
      resolvePaneMarqueePhase({ elapsedMs: 40, moved: true }),
    ).toBe("pan");
  });

  it("arms after a stationary hold, then marquees once the pointer moves", () => {
    expect(
      resolvePaneMarqueePhase({ elapsedMs: DRAG_ARM_MS, moved: false }),
    ).toBe("armed");
    expect(
      resolvePaneMarqueePhase({
        elapsedMs: DRAG_ARM_MS + 20,
        moved: true,
        armed: true,
      }),
    ).toBe("marquee");
  });

  it("does not marquee on a tap that never moved", () => {
    expect(
      resolvePaneMarqueePhase({
        elapsedMs: DRAG_ARM_MS + 80,
        moved: false,
        armed: true,
      }),
    ).toBe("armed");
  });
});

describe("nodesIntersectingMarquee", () => {
  it("selects nodes whose boxes intersect the flow-space rect", () => {
    const nodes = [
      node("a", 0, 0, { width: 100, height: 50 }),
      node("b", 400, 0, { width: 100, height: 50 }),
      node("c", 50, 200, { width: 100, height: 50 }),
    ];
    expect(
      nodesIntersectingMarquee(nodes, { x: 0, y: 0, width: 120, height: 60 }),
    ).toEqual(["a"]);
    expect(
      nodesIntersectingMarquee(nodes, { x: 40, y: 0, width: 400, height: 40 }),
    ).toEqual(["a", "b"]);
  });

  it("uses fallback size when a node has not been measured", () => {
    const nodes = [node("wide", 0, 0)];
    expect(
      nodesIntersectingMarquee(nodes, {
        x: MARQUEE_FALLBACK_WIDTH - 10,
        y: 0,
        width: 20,
        height: MARQUEE_FALLBACK_HEIGHT,
      }),
    ).toEqual(["wide"]);
    expect(
      nodesIntersectingMarquee(nodes, {
        x: MARQUEE_FALLBACK_WIDTH + 1,
        y: 0,
        width: 20,
        height: 20,
      }),
    ).toEqual([]);
  });
});

function dispatchPointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  target.dispatchEvent(event);
}

describe("attachGraphPaneMarquee", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("emits a screen rect after a stationary hold then move on the empty pane", () => {
    const wrapper = document.createElement("div");
    const pane = document.createElement("div");
    pane.className = "react-flow__pane";
    wrapper.appendChild(pane);
    document.body.appendChild(wrapper);
    wrapper.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }) as DOMRect;

    const rects: Array<ScreenRect | null> = [];
    const ends: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> =
      [];
    const handle = attachGraphPaneMarquee(wrapper, {
      onMarqueeRect: (rect) => rects.push(rect),
      onMarqueeEnd: (start, end) => ends.push({ start, end }),
    });

    vi.useFakeTimers();
    dispatchPointer(pane, "pointerdown", 20, 20);
    vi.advanceTimersByTime(DRAG_ARM_MS);
    dispatchPointer(pane, "pointermove", 140, 110);
    expect(rects.at(-1)).toEqual({ x: 20, y: 20, width: 120, height: 90 });

    dispatchPointer(pane, "pointerup", 140, 110);
    expect(ends).toEqual([
      { start: { x: 20, y: 20 }, end: { x: 140, y: 110 } },
    ]);
    handle.dispose();
  });

  it("does not marquee when the pointer moves before the arm delay", () => {
    const wrapper = document.createElement("div");
    const pane = document.createElement("div");
    pane.className = "react-flow__pane";
    wrapper.appendChild(pane);
    document.body.appendChild(wrapper);

    const rects: Array<ScreenRect | null> = [];
    const handle = attachGraphPaneMarquee(wrapper, {
      onMarqueeRect: (rect) => rects.push(rect),
      onMarqueeEnd: () => {
        throw new Error("should not end a marquee");
      },
    });

    vi.useFakeTimers();
    dispatchPointer(pane, "pointerdown", 20, 20);
    dispatchPointer(pane, "pointermove", 140, 110);
    vi.advanceTimersByTime(DRAG_ARM_MS);
    expect(rects.filter((rect) => rect !== null)).toEqual([]);
    handle.dispose();
  });
});
