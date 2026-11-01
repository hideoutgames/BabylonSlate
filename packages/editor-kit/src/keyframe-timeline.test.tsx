import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { KeyframeTimeline, type KeyframeTimelineTrackRow } from "./keyframe-timeline";
import { keyRefId, type KeyRef } from "./keyframe-timeline-model";
import { dispatchPointerEvent } from "./test-support/pointer-events";

// Lanes 400 px wide showing a 4 s clip between gutters of 10 and 24 px: 91.5 px per second, so t sits at x = 91.5t + 10.
const WIDTH = 400;
const x = (time: number) => time * 91.5 + 10;
const ROW = 24;
const y = (row: number) => row * ROW + ROW / 2;

const rows: KeyframeTimelineTrackRow[] = [
  { id: "door", kind: "group", depth: 0, label: "Door", expanded: true, keys: [{ id: "s1", time: 1, shape: "diamond" }, { id: "s2", time: 2, shape: "diamond" }] },
  { id: "loc", kind: "track", depth: 1, label: "Location", value: "0, 0, 1", connect: true,
    keys: [{ id: "k1", time: 1, shape: "diamond" }, { id: "k2", time: 2, shape: "circle" }] },
  { id: "vis", kind: "track", depth: 1, label: "Visible", keys: [{ id: "k3", time: 3, shape: "square" }] },
];

function Harness(props: {
  onSelect?: (refs: KeyRef[], mode: string) => void;
  onMove?: (delta: number, phase: string) => void;
  onTime?: (time: number, phase: string) => void;
  onRowMenu?: (rowId: string) => void;
  onToggle?: (rowId: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [time, setTime] = useState(0.5);
  const [row, setRow] = useState<string | null>(null);
  return (
    <>
      <KeyframeTimeline
        rows={rows}
        length={4}
        frameRate={30}
        time={time}
        onTimeChange={(next, phase) => { setTime(next); props.onTime?.(next, phase); }}
        selectedKeys={selected}
        onSelectKeys={(refs, mode) => {
          props.onSelect?.(refs, mode);
          setSelected((current) => {
            const next = mode === "replace" ? new Set<string>() : new Set(current);
            for (const ref of refs) {
              const id = keyRefId(ref);
              if (mode === "toggle" && next.has(id)) next.delete(id);
              else next.add(id);
            }
            return next;
          });
        }}
        onMoveKeys={props.onMove}
        selectedRowId={row}
        onSelectRow={setRow}
        onToggleRow={props.onToggle}
        onRowContextMenu={(id) => props.onRowMenu?.(id)}
        header={<span>Filter</span>}
        footer={<button type="button">Add Track</button>}
        aria-label="Intro"
      />
      <output data-testid="selected">{[...selected].map((id) => id.split("\u0000")[1]).sort().join(",")}</output>
      <output data-testid="row">{row ?? "none"}</output>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(WIDTH);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, WIDTH, 200));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const lanes = () => screen.getByRole("group", { name: "Intro" });
const press = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: Record<string, unknown> = {}) =>
  act(() => dispatchPointerEvent(lanes(), type, { pointerType: "mouse", clientX, clientY, ...extra }));

describe("KeyframeTimeline", () => {
  it("selects a key on click, adds with Shift, toggles with Ctrl and clears on empty space", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    press("pointerdown", x(1) + 3, y(1));
    press("pointerup", x(1) + 3, y(1));
    expect(screen.getByTestId("selected").textContent).toBe("k1");

    press("pointerdown", x(3), y(2), { shiftKey: true });
    press("pointerup", x(3), y(2), { shiftKey: true });
    expect(screen.getByTestId("selected").textContent).toBe("k1,k3");

    press("pointerdown", x(1), y(1), { ctrlKey: true });
    press("pointerup", x(1), y(1), { ctrlKey: true });
    expect(screen.getByTestId("selected").textContent).toBe("k3");

    press("pointerdown", x(0.4), y(1));
    press("pointerup", x(0.4), y(1));
    expect(screen.getByTestId("selected").textContent).toBe("");
    expect(onSelect).toHaveBeenLastCalledWith([], "replace");
  });

  it("drags the selection by whole frames as one gesture", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    press("pointerdown", x(1), y(1));
    press("pointermove", x(1) + 2, y(1));
    expect(onMove).not.toHaveBeenCalled();
    // 0.51 s to the right lands the grabbed key on frame 45 (1.5 s).
    press("pointermove", x(1.51), y(1));
    press("pointerup", x(1.51), y(1));
    expect(onMove.mock.calls.map(([delta, phase]) => [Number(delta.toFixed(4)), phase])).toEqual([[0, "start"], [0.5, "move"], [0.5, "end"]]);
  });

  it("marquees keys across rows with the mouse", () => {
    render(<Harness />);
    press("pointerdown", x(0.5), 30);
    press("pointermove", x(2.5), 70);
    press("pointerup", x(2.5), 70);
    expect(screen.getByTestId("selected").textContent).toBe("k1,k2");
  });

  it("scrolls instead of marqueeing when a finger drags empty space, and a tap clears", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    act(() => dispatchPointerEvent(lanes(), "pointerdown", { pointerType: "touch", clientX: x(0.5), clientY: 30 }));
    act(() => dispatchPointerEvent(lanes(), "pointermove", { pointerType: "touch", clientX: x(2.5), clientY: 70 }));
    act(() => dispatchPointerEvent(lanes(), "pointerup", { pointerType: "touch", clientX: x(2.5), clientY: 70 }));
    expect(onSelect).not.toHaveBeenCalled();
    act(() => dispatchPointerEvent(lanes(), "pointerdown", { pointerType: "touch", clientX: x(3.5), clientY: 30 }));
    act(() => dispatchPointerEvent(lanes(), "pointerup", { pointerType: "touch", clientX: x(3.5), clientY: 30 }));
    expect(onSelect).toHaveBeenCalledWith([], "replace");
  });

  it("scrubs the ruler to frames and steps it with the arrow keys", () => {
    const onTime = vi.fn();
    render(<Harness onTime={onTime} />);
    const ruler = screen.getByRole("slider", { name: "Playhead" });
    act(() => dispatchPointerEvent(ruler, "pointerdown", { pointerType: "mouse", clientX: x(2.01) }));
    act(() => dispatchPointerEvent(ruler, "pointermove", { pointerType: "mouse", clientX: x(9) }));
    act(() => dispatchPointerEvent(ruler, "pointerup", { pointerType: "mouse", clientX: x(9) }));
    expect(onTime.mock.calls.map(([time, phase]) => [Number(time.toFixed(4)), phase])).toEqual([[2, "start"], [4, "move"], [4, "end"]]);
    fireEvent.keyDown(ruler, { key: "Home" });
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    expect(Number(onTime.mock.lastCall![0].toFixed(4))).toBeCloseTo(1 / 30, 4);
    expect(ruler.getAttribute("aria-valuetext")).toBe("0.03 s");
  });

  it("selects, toggles and opens the menu of track list rows", () => {
    const onToggle = vi.fn();
    const onRowMenu = vi.fn();
    render(<Harness onToggle={onToggle} onRowMenu={onRowMenu} />);
    const items = screen.getAllByRole("treeitem");
    expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "2"]);
    fireEvent.click(items[1]!);
    expect(screen.getByTestId("row").textContent).toBe("loc");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onToggle).toHaveBeenCalledWith("door");
    expect(screen.getByTestId("row").textContent).toBe("loc");
    fireEvent.contextMenu(items[2]!);
    expect(onRowMenu).toHaveBeenCalledWith("vis");
    expect(screen.getByTestId("row").textContent).toBe("vis");
    expect(screen.getByText("0, 0, 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Track" })).toBeTruthy();
  });
});
