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
  onKeyMenu?: (ref: KeyRef) => void;
  onLength?: (length: number, phase: string) => void;
  fitToken?: number;
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
        onKeyContextMenu={props.onKeyMenu ? (ref) => props.onKeyMenu!(ref) : undefined}
        onLengthChange={props.onLength}
        fitToken={props.fitToken}
        header={<span>Filter</span>}
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

  it("zooms about the playhead with Zoom In and Zoom Out, as far as the furthest scale", () => {
    render(<Harness />);
    const zoom = () => screen.getByTestId("keyframe-timeline-zoom").textContent;
    expect(zoom()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(zoom()).toBe("150%");
    // The playhead at 0.5 s keeps its x, and 1 s is now 0.5 s at 137.25 px per second to its right.
    expect(screen.getByTestId("keyframe-timeline-lane-playhead").style.left).toBe(`${Math.round(x(0.5))}px`);
    press("pointerdown", x(0.5) + 0.5 * 137.25, y(1));
    press("pointerup", x(0.5) + 0.5 * 137.25, y(1));
    expect(screen.getByTestId("selected").textContent).toBe("k1");
    // 137.25 px per second reaches the furthest scale, 4, in nine steps of 1.5.
    const zoomOut = screen.getByRole("button", { name: "Zoom Out" }) as HTMLButtonElement;
    for (let step = 0; step < 9; step++) fireEvent.click(zoomOut);
    expect(zoomOut.disabled).toBe(true);
    expect(zoom()).toBe("4%");
  });

  it("pans with the scroll bar's thumb, zooms with its ends, and brings it where the track is pressed", () => {
    render(<Harness />);
    const bar = screen.getByRole("scrollbar", { name: "Scroll Time" });
    const zoom = () => screen.getByTestId("keyframe-timeline-zoom").textContent;
    const drag = (from: number, to: number) => {
      act(() => dispatchPointerEvent(bar, "pointerdown", { pointerType: "mouse", clientX: from }));
      act(() => dispatchPointerEvent(bar, "pointermove", { pointerType: "mouse", clientX: to }));
      act(() => dispatchPointerEvent(bar, "pointerup", { pointerType: "mouse", clientX: to }));
    };
    // Fitted, the thumb fills the track, so its middle has nowhere to go.
    drag(200, 250);
    expect(zoom()).toBe("100%");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    // Its right end 100 px left: the track's 4.37 s lose 1.09 s, so 3.28 s fill the lanes at 122 px per second,
    // still from -0.11 s; 2 s is now at 2.11 × 122 px.
    drag(398, 298);
    expect(zoom()).toBe("133%");
    press("pointerdown", 2.1093 * 122, y(1));
    press("pointerup", 2.1093 * 122, y(1));
    expect(screen.getByTestId("selected").textContent).toBe("k2");
    // Its middle dragged to the track's end shows the clip's end.
    drag(150, 400);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    // A press at the track's start brings the thumb there.
    drag(1, 1);
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    // The arrow keys pan by a tenth of the 3.28 s shown, of the 1 s the thumb can travel.
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    fireEvent.keyDown(bar, { key: "End" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(zoom()).toBe("133%");
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
  });

  it("moves keys off the frame grid while Alt is held", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    press("pointerdown", x(1), y(1));
    press("pointermove", x(1.51), y(1), { altKey: true });
    press("pointerup", x(1.51), y(1), { altKey: true });
    expect(onMove.mock.calls.at(-1)![0]).toBeCloseTo(0.51, 2);
  });

  it("opens a key's menu on right-click or a held finger, selecting the key first", () => {
    vi.useFakeTimers();
    try {
      const onKeyMenu = vi.fn();
      const onMove = vi.fn();
      render(<Harness onKeyMenu={onKeyMenu} onMove={onMove} />);
      fireEvent.contextMenu(lanes(), { clientX: x(3), clientY: y(2) });
      expect(onKeyMenu).toHaveBeenCalledWith({ rowId: "vis", keyId: "k3" });
      expect(screen.getByTestId("selected").textContent).toBe("k3");
      // Empty space has no key menu.
      fireEvent.contextMenu(lanes(), { clientX: x(0.3), clientY: y(2) });
      expect(onKeyMenu).toHaveBeenCalledTimes(1);

      act(() => dispatchPointerEvent(lanes(), "pointerdown", { pointerType: "touch", clientX: x(2) + 15, clientY: y(1) }));
      act(() => { vi.advanceTimersByTime(520); });
      expect(onKeyMenu).toHaveBeenLastCalledWith({ rowId: "loc", keyId: "k2" });
      act(() => dispatchPointerEvent(lanes(), "pointermove", { pointerType: "touch", clientX: x(3), clientY: y(1) }));
      act(() => dispatchPointerEvent(lanes(), "pointerup", { pointerType: "touch", clientX: x(3), clientY: y(1) }));
      expect(onMove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drags the clip's end on the ruler to change the length, on frames", () => {
    const onLength = vi.fn();
    const onTime = vi.fn();
    render(<Harness onLength={onLength} onTime={onTime} />);
    const ruler = screen.getByRole("slider", { name: "Playhead" });
    expect(screen.getByTestId("keyframe-timeline-end")).toBeTruthy();
    act(() => dispatchPointerEvent(ruler, "pointerdown", { pointerType: "mouse", clientX: x(4) + 2 }));
    act(() => dispatchPointerEvent(ruler, "pointermove", { pointerType: "mouse", clientX: x(3.01) }));
    act(() => dispatchPointerEvent(ruler, "pointerup", { pointerType: "mouse", clientX: x(3.01) }));
    expect(onLength.mock.calls.map(([length, phase]) => [Number(length.toFixed(4)), phase])).toEqual([[4, "start"], [3, "move"], [3, "end"]]);
    expect(onTime).not.toHaveBeenCalled();
  });

  it("selects an unselected key on a finger's tap or drag, not on a hold", () => {
    const onMove = vi.fn();
    render(<Harness onKeyMenu={() => {}} onMove={onMove} />);
    const touch = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number) =>
      act(() => dispatchPointerEvent(lanes(), type, { pointerType: "touch", clientX, clientY: y(1) }));
    touch("pointerdown", x(1));
    expect(screen.getByTestId("selected").textContent).toBe("");
    touch("pointerup", x(1));
    expect(screen.getByTestId("selected").textContent).toBe("k1");
    // Dragging an unselected key selects it, then moves it from the next event on.
    touch("pointerdown", x(2));
    touch("pointermove", x(2) + 20);
    expect(screen.getByTestId("selected").textContent).toBe("k2");
    expect(onMove).not.toHaveBeenCalled();
    touch("pointermove", x(2.5));
    touch("pointerup", x(2.5));
    expect(onMove.mock.calls.map(([, phase]) => phase)).toEqual(["start", "move", "end"]);
  });
});

describe("KeyframeTimeline lanes", () => {
  let theme: Record<string, string>;
  let fills: string[];
  let clears: number;

  beforeEach(() => {
    theme = { "--border": "#101010", "--selection": "#202020", "--foreground": "#303030" };
    fills = [];
    clears = 0;
    const context = {
      fillStyle: "",
      fillRect() { fills.push(context.fillStyle); },
      clearRect() { clears += 1; },
      setTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
      rect() {}, clip() {}, fill() {}, stroke() {}, strokeRect() {}, fillText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => context as unknown as CanvasRenderingContext2D,
    );
    const computed = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) =>
      element instanceof HTMLCanvasElement
        ? ({ getPropertyValue: (name: string) => theme[name] ?? "" } as unknown as CSSStyleDeclaration)
        : computed(element, pseudo));
  });

  it("redraws in the new theme's colours as soon as the theme stylesheet changes", async () => {
    render(<Harness />);
    expect(fills).toContain("#101010");
    fills = [];
    theme = { ...theme, "--border": "#a0a0a0" };
    const stylesheet = document.createElement("style");
    try {
      await act(async () => {
        document.head.append(stylesheet);
        await Promise.resolve();
      });
      expect(fills).toContain("#a0a0a0");
      expect(fills).not.toContain("#101010");
    } finally {
      stylesheet.remove();
    }
  });

  it("moves the lane playhead line with the playhead without redrawing the lanes", () => {
    render(<Harness />);
    const line = screen.getByTestId("keyframe-timeline-lane-playhead");
    expect(line.style.left).toBe(`${Math.round(x(0.5))}px`);
    const drawn = clears;
    act(() => {
      fireEvent.keyDown(screen.getByRole("slider", { name: "Playhead" }), { key: "ArrowRight" });
    });
    expect(screen.getByTestId("keyframe-timeline-lane-playhead").style.left).toBe(`${Math.round(x(16 / 30))}px`);
    expect(clears).toBe(drawn);
  });
});
