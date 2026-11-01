import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurveEditor } from "./curve-editor";
import { GradientEditor } from "./gradient-editor";
import { CurveValueField } from "./curve-value-field";
import type { CurveEditorConstraints, CurveEditorKind, CurveEditorValue } from "./curve-editor-model";
import { dispatchPointerEvent, stubPointerCapture } from "./test-support/pointer-events";

let restoreCapture: () => void;
beforeEach(() => {
  restoreCapture = stubPointerCapture();
  // Every plot and bar measures 100 × 100 px at the origin, so client coordinates are percentages.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  );
});
afterEach(() => {
  cleanup();
  restoreCapture();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const key = (Time: number, Value: unknown, Interpolation = "linear", tangent: unknown = 0) =>
  ({ Time, Value, Interpolation, ArriveTangent: tangent, LeaveTangent: tangent });
const curve = (...keys: unknown[]): CurveEditorValue => ({ Keys: keys, Before: "constant", After: "constant" });
const FIXED: CurveEditorConstraints = { fixedTime: true, valueMin: 0, valueMax: 10 };

function Stateful({ kind = "float", initial, constraints, onChange }: {
  kind?: CurveEditorKind; initial: CurveEditorValue; constraints?: CurveEditorConstraints; onChange: (value: CurveEditorValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return <CurveEditor kind={kind} aria-label="Falloff" value={value} constraints={constraints}
    onChange={(next) => { setValue(next); onChange(next); }} data-testid="curve" />;
}

const keysOf = (value: CurveEditorValue) => value.Keys as Array<{ Time: number; Value: unknown; Interpolation: string; ArriveTangent: unknown; LeaveTangent: unknown }>;

describe("CurveEditor", () => {
  it("moves a dragged key with the pointer and reports one change when the drag ends", () => {
    const onChange = vi.fn();
    render(<Stateful initial={curve(key(0, 0), key(0.5, 5), key(1, 10))} constraints={FIXED} onChange={onChange} />);
    const handle = screen.getByTestId("curve-key-1");
    dispatchPointerEvent(handle, "pointerdown", { clientX: 50, clientY: 50 });
    dispatchPointerEvent(handle, "pointermove", { clientX: 30, clientY: 50 });
    dispatchPointerEvent(handle, "pointermove", { clientX: 40, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled();
    dispatchPointerEvent(handle, "pointerup", { clientX: 40, clientY: 20 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(keysOf(onChange.mock.lastCall![0])[1]).toMatchObject({ Time: 0.4, Value: 8 });
  });

  it("drags a Custom key's tangent handle into one change that sets both tangents", () => {
    const onChange = vi.fn();
    render(<Stateful initial={curve(key(0, 0, "custom"), key(1, 10, "custom"))} constraints={FIXED} onChange={onChange} />);
    act(() => {
      dispatchPointerEvent(screen.getByTestId("curve-key-0"), "pointerdown", { clientX: 0, clientY: 100 });
      dispatchPointerEvent(screen.getByTestId("curve-key-0"), "pointerup", { clientX: 0, clientY: 100 });
    });
    const leave = screen.getByTestId("curve-tangent-leave");
    dispatchPointerEvent(leave, "pointerdown", { clientX: 10, clientY: 90 });
    dispatchPointerEvent(leave, "pointermove", { clientX: 20, clientY: 80 });
    dispatchPointerEvent(leave, "pointermove", { clientX: 50, clientY: 50 });
    dispatchPointerEvent(leave, "pointerup", { clientX: 50, clientY: 50 });
    expect(onChange).toHaveBeenCalledTimes(1);
    // Half the width and half the height of a 1 s × 10 plot: a slope of 10 per second.
    expect(keysOf(onChange.mock.lastCall![0])[0]).toMatchObject({ ArriveTangent: 10, LeaveTangent: 10 });
  });

  it("shows an Auto key's tangent and makes the key Custom, keeping its shape, when the handle is dragged", () => {
    const onChange = vi.fn();
    const zero = { x: 0, y: 0, z: 0 };
    render(<Stateful kind="vec3" initial={curve(key(0, zero, "auto", zero), key(1, { x: 10, y: 10, z: 5 }, "auto", zero))} constraints={FIXED} onChange={onChange} />);
    act(() => {
      dispatchPointerEvent(screen.getByTestId("curve-key-0-y"), "pointerdown", { clientX: 0, clientY: 100 });
      dispatchPointerEvent(screen.getByTestId("curve-key-0-y"), "pointerup", { clientX: 0, clientY: 100 });
    });
    const leave = screen.getByTestId("curve-tangent-leave");
    dispatchPointerEvent(leave, "pointerdown", { clientX: 10, clientY: 90 });
    dispatchPointerEvent(leave, "pointermove", { clientX: 50, clientY: 75 });
    dispatchPointerEvent(leave, "pointerup", { clientX: 50, clientY: 75 });
    expect(onChange).toHaveBeenCalledTimes(1);
    const first = keysOf(onChange.mock.lastCall![0])[0];
    // Y follows the handle (a quarter of 10 over half a second); X and Z keep the slopes they played with (10 and 5).
    expect(first).toMatchObject({ Interpolation: "custom", ArriveTangent: { x: 10, y: 5, z: 5 }, LeaveTangent: { x: 10, y: 5, z: 5 } });
    expect(keysOf(onChange.mock.lastCall![0])[1]).toMatchObject({ Interpolation: "auto" });
  });

  it("hides tangent handles for Linear keys", () => {
    render(<Stateful initial={curve(key(0, 0, "linear"), key(1, 10))} constraints={FIXED} onChange={vi.fn()} />);
    expect(screen.queryByTestId("curve-tangent-leave")).toBeNull();
  });

  it("pans by dragging empty space, zooms with Ctrl-wheel, and Fit restores the framed view", () => {
    render(<Stateful initial={curve(key(0, 0), key(1, 1))} onChange={vi.fn()} />);
    // The framed view runs from -0.05 s to 1.05 s, so the key at 1 s sits 1.05 / 1.1 of the way across.
    const across = () => parseFloat(screen.getByTestId("curve-key-1").style.left);
    expect(across()).toBeCloseTo(95.45, 1);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 25, clientY: 50 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 25, clientY: 50 });
    });
    // A quarter of the plot to the left.
    expect(across()).toBeCloseTo(70.45, 1);
    // Zooming in around the middle (0.775 s), level with the key (value 1 of -0.1 to 1.1), pushes it away from the middle.
    act(() => { track.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -200, clientX: 50, clientY: 100 / 12, cancelable: true })); });
    expect(across()).toBeCloseTo(80.52, 0);
    fireEvent.click(screen.getByTestId("curve-fit"));
    expect(across()).toBeCloseTo(95.45, 1);
  });

  it("keeps the view where an edit left it until Fit frames the keys again", () => {
    render(<Stateful initial={curve(key(0, 0), key(1, 1))} onChange={vi.fn()} />);
    const across = () => parseFloat(screen.getByTestId("curve-key-1").style.left);
    const handle = screen.getByTestId("curve-key-1");
    act(() => {
      dispatchPointerEvent(handle, "pointerdown", { clientX: 95, clientY: 50 });
      dispatchPointerEvent(handle, "pointermove", { clientX: 100, clientY: 50 });
      dispatchPointerEvent(handle, "pointerup", { clientX: 100, clientY: 50 });
    });
    // Dropped at the right edge (1.05 s) and still drawn there; a refit would have pulled it back in.
    expect(across()).toBeCloseTo(100, 1);
    fireEvent.click(screen.getByTestId("curve-fit"));
    expect(across()).toBeCloseTo(95.45, 1);
  });

  it("reads out every channel under a hovering mouse, and nothing once it leaves", () => {
    render(<Stateful kind="vec3" initial={curve(key(0, { x: 0, y: 2, z: 4 }), key(1, { x: 10, y: 2, z: 0 }))} constraints={FIXED} onChange={vi.fn()} />);
    const track = screen.getByTestId("curve-track");
    act(() => { dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 50, clientY: 50 }); });
    expect(screen.getByTestId("curve-hover-time").textContent).toBe("0.50 s");
    expect(screen.getByTestId("curve-hover").textContent).toBe("X5.00Y2.00Z2.00");
    act(() => { fireEvent.pointerLeave(track); });
    expect(screen.queryByTestId("curve-hover")).toBeNull();
    // Touch never hovers.
    act(() => { dispatchPointerEvent(track, "pointermove", { pointerType: "touch", clientX: 50, clientY: 50 }); });
    expect(screen.queryByTestId("curve-hover")).toBeNull();
  });

  it("caps touch hit boxes at the gap to the nearest key", () => {
    render(<Stateful initial={curve(key(0, 0), key(0.1, 5), key(1, 10))} constraints={FIXED} onChange={vi.fn()} />);
    expect(screen.getByTestId("curve-key-1").style.getPropertyValue("--curve-key-hit")).toBe("10%");
    expect(screen.getByTestId("curve-key-2").style.getPropertyValue("--curve-key-hit")).toBe("90%");
  });

  it("offers Add Key Here after a long press on empty space and adds the key there", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Stateful initial={curve(key(0, 0), key(1, 10))} constraints={FIXED} onChange={onChange} />);
    const track = screen.getByTestId("curve-track");
    dispatchPointerEvent(track, "pointerdown", { pointerType: "touch", clientX: 50, clientY: 50 });
    act(() => { vi.advanceTimersByTime(500); });
    dispatchPointerEvent(track, "pointerup", { pointerType: "touch", clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Add Key Here" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(keysOf(onChange.mock.lastCall![0]).map((entry) => [entry.Time, entry.Value])).toEqual([[0, 0], [0.5, 5], [1, 10]]);
  });

  it("keeps key times on the step and inside the range, with fixed ends and no extrapolation pickers", () => {
    const onChange = vi.fn();
    render(<Stateful initial={curve(key(1, 0), key(3, 5))} onChange={onChange}
      constraints={{ timeRange: [0, 4], timeSnap: 0.5, extrapolation: "constant" }} />);
    expect(screen.queryByTestId("curve-before")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("curve-key-0"));
    fireEvent.pointerUp(screen.getByTestId("curve-key-0"));
    const time = screen.getByTestId("curve-time");
    const type = (value: string) => {
      act(() => time.focus());
      fireEvent.change(time, { target: { value } });
      fireEvent.keyDown(time, { key: "Enter" });
      act(() => time.blur());
    };
    type("1.3");
    expect(keysOf(onChange.mock.lastCall![0])[0]!.Time).toBe(1.5);
    type("-2");
    expect(keysOf(onChange.mock.lastCall![0])[0]!.Time).toBe(0);
    expect(onChange.mock.lastCall![0]).toMatchObject({ Before: "constant", After: "constant" });
  });

  it("drags one channel of a Vector key and leaves the others", () => {
    const onChange = vi.fn();
    const zero = { x: 0, y: 0, z: 0 };
    render(<Stateful kind="vec3" initial={curve(key(0, zero, "linear", zero), key(1, { x: 10, y: 10, z: 10 }, "linear", zero))} constraints={FIXED} onChange={onChange} />);
    const handle = screen.getByTestId("curve-key-1-y");
    dispatchPointerEvent(handle, "pointerdown", { clientX: 100, clientY: 0 });
    dispatchPointerEvent(handle, "pointermove", { clientX: 100, clientY: 50 });
    dispatchPointerEvent(handle, "pointerup", { clientX: 100, clientY: 50 });
    expect(keysOf(onChange.mock.lastCall![0])[1]!.Value).toEqual({ x: 10, y: 5, z: 10 });
  });
});

describe("CurveEditor window layout", () => {
  function Window({ kind = "float", initial, onChange }: { kind?: CurveEditorKind; initial: CurveEditorValue; onChange: (value: CurveEditorValue) => void }) {
    const [value, setValue] = useState(initial);
    return <CurveEditor layout="window" kind={kind} aria-label="Falloff" value={value}
      onChange={(next) => { setValue(next); onChange(next); }} data-testid="curve" />;
  }

  it("steps through the keys in the key bar and leaves Before and After to its host", () => {
    render(<Window initial={curve(key(0, 1), key(0.5, 0.25), key(2, 0))} onChange={vi.fn()} />);
    expect(screen.getByTestId("curve-key-count").textContent).toBe("Key 1 of 3");
    expect(screen.queryByTestId("curve-before")).toBeNull();
    expect(screen.queryByTestId("curve-after")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next Key" }));
    expect(screen.getByTestId("curve-key-count").textContent).toBe("Key 2 of 3");
    expect((screen.getByTestId("curve-value") as HTMLInputElement).value).toBe("0.25");
    fireEvent.click(screen.getByRole("button", { name: "Next Key" }));
    expect((screen.getByRole("button", { name: "Next Key" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous Key" }));
    expect(screen.getByTestId("curve-key-count").textContent).toBe("Key 2 of 3");
  });

  it("drags a Color Curve's gradient stop in time only, and selects its key", () => {
    const onChange = vi.fn();
    const red = { x: 1, y: 0, z: 0, w: 1 };
    const blue = { x: 0, y: 0, z: 1, w: 0.5 };
    render(<Window kind="color" initial={curve(key(0, red, "linear", red), key(1, blue, "linear", blue))} onChange={onChange} />);
    const stop = screen.getByTestId("curve-stop-1");
    act(() => { dispatchPointerEvent(stop, "pointerdown", { clientX: 90, clientY: 50 }); });
    expect(screen.getByTestId("curve-key-count").textContent).toBe("Key 2 of 2");
    act(() => {
      dispatchPointerEvent(stop, "pointermove", { clientX: 50, clientY: 0 });
      dispatchPointerEvent(stop, "pointerup", { clientX: 50, clientY: 0 });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    // The window frames 0.12 s past each end: the middle of the plot is 0.5 s, and the colour stays.
    expect(keysOf(onChange.mock.lastCall![0])[1]).toMatchObject({ Time: 0.5, Value: blue });
  });
});

describe("GradientEditor", () => {
  it("drags a stop along the bar into one change and keeps locked end stops in place", () => {
    const onChange = vi.fn();
    const color = (x: number) => ({ x, y: 0, z: 0, w: 1 });
    render(<GradientEditor aria-label="Tint" value={curve(key(0, color(0)), key(0.5, color(0.5)), key(1, color(1)))}
      constraints={{ fixedTime: true, lockEnds: true }} onChange={onChange} data-testid="tint" />);
    const stop = screen.getByTestId("tint-stop-1");
    dispatchPointerEvent(stop, "pointerdown", { clientX: 50 });
    dispatchPointerEvent(stop, "pointermove", { clientX: 70 });
    dispatchPointerEvent(stop, "pointermove", { clientX: 80 });
    dispatchPointerEvent(stop, "pointerup", { clientX: 80 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(keysOf(onChange.mock.lastCall![0]).map((entry) => entry.Time)).toEqual([0, 0.8, 1]);
    const end = screen.getByTestId("tint-stop-2");
    dispatchPointerEvent(end, "pointerdown", { clientX: 100 });
    dispatchPointerEvent(end, "pointermove", { clientX: 60 });
    dispatchPointerEvent(end, "pointerup", { clientX: 60 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("CurveValueField", () => {
  it("summarises the key count and switches a Color Curve between its gradient and channel curves", () => {
    const color = (x: number) => ({ x, y: x, z: x, w: 1 });
    render(<CurveValueField kind="color" aria-label="Tint Over Life" value={curve(key(0, color(0)), key(1, color(1)))} onChange={vi.fn()} data-testid="tint" />);
    const toggle = screen.getByRole("button", { name: "Tint Over Life, 2 Keys" });
    fireEvent.click(toggle);
    expect(screen.getByTestId("tint-gradient")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    expect(screen.getByTestId("tint-editor-key-0-x")).toBeTruthy();
    expect(screen.queryByTestId("tint-gradient")).toBeNull();
  });
});
