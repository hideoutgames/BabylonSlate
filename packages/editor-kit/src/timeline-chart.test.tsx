import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TimelineChart, type TimelineSelection } from "./timeline-chart";
import type { TimelineDomain, TimelineTrack } from "./timeline-chart-model";
import { dispatchPointerEvent } from "./test-support/pointer-events";

// 300 px wide: 100 buckets of 3 px over a 0-100 ms domain, so a sample at t ms sits at x = 3t + 1.5.
const WIDTH = 300;
const x = (time: number) => time * 3 + 1.5;

const ticks: TimelineTrack = {
  id: "ticks",
  label: "Ticks",
  unit: "ms",
  times: [10, 50, 90],
  threshold: 8,
  segments: [
    { label: "Script", values: [1, 6, 2], color: "--trace-script" },
    { label: "Physics", values: [2, 4, 1], color: "--trace-physics" },
  ],
};

function Harness({ onRange }: { onRange?: (range: TimelineDomain | null) => void }) {
  const [selected, setSelected] = useState<TimelineSelection | null>(null);
  const [range, setRange] = useState<TimelineDomain | null>(null);
  return (
    <>
      <TimelineChart
        tracks={[ticks]}
        markers={[{ atMs: 20, endMs: 30, label: "Loading", color: "--muted-foreground" }]}
        domain={[0, 100]}
        selected={selected}
        range={range}
        onSelect={setSelected}
        onRangeChange={(next) => { setRange(next); onRange?.(next); }}
        formatTime={(ms) => `${ms} ms`}
        aria-label="Timeline"
      />
      <output data-testid="selected">{selected ? `${selected.track} ${selected.index}` : "none"}</output>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(WIDTH);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, WIDTH, 74));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TimelineChart", () => {
  it("selects the sample under a tap, steps through its track with the arrow keys, and clears a range with Escape", () => {
    const onRange = vi.fn();
    render(<Harness onRange={onRange} />);
    const plot = screen.getByRole("group", { name: "Timeline" });
    act(() => {
      dispatchPointerEvent(plot, "pointerdown", { clientX: x(50), clientY: 20 });
      dispatchPointerEvent(plot, "pointerup", { clientX: x(50), clientY: 20 });
    });
    expect(screen.getByTestId("selected").textContent).toBe("ticks 1");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByTestId("selected").textContent).toBe("ticks 2");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByTestId("selected").textContent).toBe("ticks 2");

    // A drag selects a range instead of a sample.
    act(() => {
      dispatchPointerEvent(plot, "pointerdown", { clientX: x(10), clientY: 20 });
      dispatchPointerEvent(plot, "pointermove", { clientX: x(60), clientY: 20 });
      dispatchPointerEvent(plot, "pointerup", { clientX: x(60), clientY: 20 });
    });
    expect(onRange).toHaveBeenLastCalledWith([expect.closeTo(10.5), expect.closeTo(60.5)]);
    expect(screen.getByTestId("selected").textContent).toBe("ticks 2");
    expect(screen.getByText("10.5 ms – 60.5 ms")).toBeTruthy();
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(onRange).toHaveBeenLastCalledWith(null);
  });

  it("lets a finger reach further for the nearest bar than a mouse", () => {
    render(<Harness />);
    const plot = screen.getByRole("group", { name: "Timeline" });
    const tap = (pointerType: "mouse" | "touch") => act(() => {
      dispatchPointerEvent(plot, "pointerdown", { pointerType, clientX: x(55), clientY: 20 });
      dispatchPointerEvent(plot, "pointerup", { pointerType, clientX: x(55), clientY: 20 });
    });
    tap("mouse");
    expect(screen.getByTestId("selected").textContent).toBe("none");
    tap("touch");
    expect(screen.getByTestId("selected").textContent).toBe("ticks 1");
  });

  it("names a hovered sample's parts, total and budget, and a hovered marker", () => {
    render(<Harness />);
    const plot = screen.getByRole("group", { name: "Timeline" });
    act(() => dispatchPointerEvent(plot, "pointermove", { pointerType: "mouse", clientX: x(50), clientY: 20 }));
    expect(screen.getByRole("tooltip").textContent).toBe("Ticks · 50 msScript 6 msPhysics 4 msTotal 10 msOver Budget");
    act(() => dispatchPointerEvent(plot, "pointermove", { pointerType: "mouse", clientX: x(25), clientY: 64 }));
    expect(screen.getByRole("tooltip").textContent).toBe("Loading20 ms – 30 ms");
    fireEvent.pointerLeave(plot);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
