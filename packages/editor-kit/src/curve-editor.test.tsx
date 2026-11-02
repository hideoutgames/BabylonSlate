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

const keysOf = (value: CurveEditorValue) => value.Keys as Array<{ Time: number; Value: unknown; Interpolation: string; ArriveTangent: unknown; LeaveTangent: unknown; Axes?: number }>;

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

  it("pans with a right-drag, zooms with Ctrl-wheel, and Fit restores the framed view", () => {
    render(<Stateful initial={curve(key(0, 0), key(1, 1))} onChange={vi.fn()} />);
    // The framed view runs from -0.05 s to 1.05 s, so the key at 1 s sits 1.05 / 1.1 of the way across.
    const across = () => parseFloat(screen.getByTestId("curve-key-1").style.left);
    expect(across()).toBeCloseTo(95.45, 1);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", button: 2, clientX: 50, clientY: 50 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", button: 2, clientX: 25, clientY: 50 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", button: 2, clientX: 25, clientY: 50 });
    });
    // A quarter of the plot to the left, and no menu after a drag.
    expect(screen.queryByTestId("curve-add-here")).toBeNull();
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
      dispatchPointerEvent(handle, "pointermove", { clientX: 75, clientY: 50 });
      dispatchPointerEvent(handle, "pointerup", { clientX: 75, clientY: 50 });
    });
    // Moved 0.22 s earlier and drawn there; a refit would have framed it at the right end again.
    expect(across()).toBeCloseTo(75.45, 1);
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

  it("offers Add Key Here when a held finger lifts in place, and adds the key there", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Stateful initial={curve(key(0, 0), key(1, 10))} constraints={FIXED} onChange={onChange} />);
    const track = screen.getByTestId("curve-track");
    dispatchPointerEvent(track, "pointerdown", { pointerType: "touch", clientX: 50, clientY: 50 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId("curve-add-here")).toBeNull();
    act(() => { dispatchPointerEvent(track, "pointerup", { pointerType: "touch", clientX: 50, clientY: 50 }); });
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

describe("CurveEditor multi-select", () => {
  // Fixed 0–1 s and 0–10, so a key at (t, v) sits at (100t, 100 - 10v) px.
  const three = () => curve(key(0.2, 2), key(0.4, 4), key(0.8, 8));
  const pressed = () => [0, 1, 2].map((index) => screen.getByTestId(`curve-key-${index}`).getAttribute("aria-pressed"));
  const press = (index: number, at: { x: number; y: number }, init: Partial<{ shiftKey: boolean; ctrlKey: boolean; pointerType: "mouse" | "touch" }> = {}) => act(() => {
    const handle = screen.getByTestId(`curve-key-${index}`);
    dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", clientX: at.x, clientY: at.y, ...init });
    dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", clientX: at.x, clientY: at.y, ...init });
  });

  it("adds keys with Shift and moves the group together as one change", () => {
    const onChange = vi.fn();
    render(<Stateful initial={three()} constraints={FIXED} onChange={onChange} />);
    press(0, { x: 20, y: 80 });
    act(() => {
      const handle = screen.getByTestId("curve-key-1");
      dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", shiftKey: true, clientX: 40, clientY: 60 });
      dispatchPointerEvent(handle, "pointermove", { pointerType: "mouse", clientX: 45, clientY: 55 });
      dispatchPointerEvent(handle, "pointermove", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", clientX: 50, clientY: 50 });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    // Both keys move 0.1 s later and 1 higher; the third stays.
    expect(keysOf(onChange.mock.lastCall![0]).map((entry) => [entry.Time, entry.Value])).toEqual([[0.3, 3], [0.5, 5], [0.8, 8]]);
    expect(pressed()).toEqual(["true", "true", "false"]);
  });

  it("selects one key of a group with a plain click, and toggles keys with Ctrl", () => {
    render(<Stateful initial={three()} constraints={FIXED} onChange={vi.fn()} />);
    press(0, { x: 20, y: 80 });
    press(2, { x: 80, y: 20 }, { shiftKey: true });
    expect(pressed()).toEqual(["true", "false", "true"]);
    press(2, { x: 80, y: 20 });
    expect(pressed()).toEqual(["false", "false", "true"]);
    press(1, { x: 40, y: 60 }, { ctrlKey: true });
    expect(pressed()).toEqual(["false", "true", "true"]);
    press(2, { x: 80, y: 20 }, { ctrlKey: true });
    expect(pressed()).toEqual(["false", "true", "false"]);
  });

  it("selects the keys inside a mouse drag box, and the fields set them all to one value", () => {
    const onChange = vi.fn();
    render(<Stateful initial={three()} constraints={FIXED} onChange={onChange} />);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", clientX: 10, clientY: 0 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 30, clientY: 50 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 50, clientY: 100 });
    });
    expect(screen.getByTestId("curve-marquee")).toBeTruthy();
    act(() => { dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 50, clientY: 100 }); });
    expect(screen.queryByTestId("curve-marquee")).toBeNull();
    expect(pressed()).toEqual(["true", "true", "false"]);
    expect(onChange).not.toHaveBeenCalled();
    const valueField = screen.getByTestId("curve-value") as HTMLInputElement;
    expect(valueField.placeholder).toBe("Mixed");
    act(() => valueField.focus());
    fireEvent.change(valueField, { target: { value: "6" } });
    fireEvent.keyDown(valueField, { key: "Enter" });
    act(() => valueField.blur());
    expect(keysOf(onChange.mock.lastCall![0]).map((entry) => [entry.Time, entry.Value])).toEqual([[0.2, 6], [0.4, 6], [0.8, 8]]);
  });

  it("clears the selection on a click in empty space, and removes every selected key with Delete", () => {
    const onChange = vi.fn();
    render(<Stateful initial={three()} constraints={FIXED} onChange={onChange} />);
    press(0, { x: 20, y: 80 });
    press(1, { x: 40, y: 60 }, { shiftKey: true });
    expect(screen.getByTestId("curve-remove").textContent).toBe("Remove Keys");
    fireEvent.keyDown(screen.getByTestId("curve-key-1"), { key: "Delete" });
    expect(keysOf(onChange.mock.lastCall![0]).map((entry) => entry.Time)).toEqual([0.8]);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 90 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 50, clientY: 90 });
    });
    expect(screen.getByTestId("curve-key-0").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("curve-time")).toBeNull();
  });

  it("offers Add Key Here on a right-click in place", () => {
    render(<Stateful initial={three()} constraints={FIXED} onChange={vi.fn()} />);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", button: 2, clientX: 60, clientY: 40 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", button: 2, clientX: 60, clientY: 40 });
    });
    expect(screen.getByRole("button", { name: "Add Key Here" })).toBeTruthy();
  });

  it("pans with a finger drag, and selects with a box when the finger holds first", () => {
    vi.useFakeTimers();
    render(<Stateful initial={curve(key(0, 0), key(0.5, 5), key(1, 10))} onChange={vi.fn()} />);
    const across = () => parseFloat(screen.getByTestId("curve-key-1").style.left);
    const framed = across();
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "touch", clientX: 50, clientY: 90 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "touch", clientX: 30, clientY: 90 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "touch", clientX: 30, clientY: 90 });
    });
    expect(across()).toBeCloseTo(framed - 20, 1);
    expect(screen.queryByTestId("curve-marquee")).toBeNull();
    // Hold on empty space, then drag a box over the whole plot: the pan left the first key off its left edge.
    act(() => { dispatchPointerEvent(track, "pointerdown", { pointerType: "touch", clientX: 0, clientY: 0 }); });
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { dispatchPointerEvent(track, "pointermove", { pointerType: "touch", clientX: 100, clientY: 100 }); });
    act(() => { dispatchPointerEvent(track, "pointerup", { pointerType: "touch", clientX: 100, clientY: 100 }); });
    expect([0, 1, 2].map((index) => screen.getByTestId(`curve-key-${index}`).getAttribute("aria-pressed"))).toEqual(["false", "true", "true"]);
    expect(screen.queryByTestId("curve-add-here")).toBeNull();
  });
});

describe("CurveEditor Vector axes", () => {
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const zero = v(0, 0, 0);
  // Fixed 0–1 s and 0–10: a key at (t, value) sits at (100t, 100 - 10 value) px.
  const vector = () => curve(key(0, zero, "linear", zero), key(0.5, v(5, 5, 5), "linear", zero), key(1, v(10, 10, 10), "linear", zero));
  const shape = (value: CurveEditorValue) => keysOf(value).map((entry) => [entry.Time, entry.Axes]);
  const drag = (testId: string, from: number, to: number) => act(() => {
    const handle = screen.getByTestId(testId);
    dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", clientX: from, clientY: 50 });
    dispatchPointerEvent(handle, "pointermove", { pointerType: "mouse", clientX: to, clientY: 50 });
    dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", clientX: to, clientY: 50 });
  });

  it("moves one axis of a key in time on its own, and merges it back when it meets its other axes", () => {
    const onChange = vi.fn();
    render(<Stateful kind="vec3" initial={vector()} constraints={FIXED} onChange={onChange} />);
    drag("curve-key-1-x", 50, 70);
    expect(onChange).toHaveBeenCalledTimes(1);
    // X splits off to 0.7 s with its value; Y and Z stay at 0.5 s.
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.5, 6], [0.7, 1], [1, 7]]);
    expect(keysOf(onChange.mock.lastCall![0])[2]!.Value).toEqual(v(5, 5, 5));
    expect(screen.queryByTestId("curve-key-1-x")).toBeNull();
    // Dropped within 6 px of 0.5 s, X lands on its other axes and the key is whole again.
    drag("curve-key-2-x", 70, 52);
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.5, 7], [1, 7]]);
  });

  it("keeps dragging an axis after it splits off, with the plot holding the pointer", () => {
    const onChange = vi.fn();
    render(<Stateful kind="vec3" initial={vector()} constraints={FIXED} onChange={onChange} />);
    const track = screen.getByTestId("curve-track");
    act(() => { dispatchPointerEvent(screen.getByTestId("curve-key-1-x"), "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 }); });
    // Once X splits off, its handle renders as another element; the captured moves reach the plot.
    act(() => { dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 60, clientY: 50 }); });
    expect(screen.queryByTestId("curve-key-1-x")).toBeNull();
    act(() => { dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 80, clientY: 50 }); });
    act(() => { dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 80, clientY: 50 }); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.5, 6], [0.8, 1], [1, 7]]);
  });

  it("removes only the selected axis of a key", () => {
    const onChange = vi.fn();
    render(<Stateful kind="vec3" initial={vector()} constraints={FIXED} onChange={onChange} />);
    act(() => {
      const handle = screen.getByTestId("curve-key-1-y");
      dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", clientX: 50, clientY: 50 });
    });
    fireEvent.keyDown(screen.getByTestId("curve-key-1-y"), { key: "Delete" });
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.5, 5], [1, 7]]);
    // The key bar shows only the axes the selected key sets.
    expect(screen.queryByTestId("curve-key-1-y")).toBeNull();
  });

  it("changes the interpolation of the selected axis only", () => {
    const onChange = vi.fn();
    render(<Stateful kind="vec3" initial={vector()} constraints={FIXED} onChange={onChange} />);
    act(() => {
      const handle = screen.getByTestId("curve-key-1-x");
      dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", clientX: 50, clientY: 50 });
    });
    fireEvent.click(screen.getByTestId("curve-interpolation"));
    const constant = screen.getByRole("option", { name: "Constant" });
    fireEvent.pointerDown(constant);
    fireEvent.click(constant);
    const keys = keysOf(onChange.mock.lastCall![0]);
    expect(keys.map((entry) => [entry.Time, entry.Axes, entry.Interpolation])).toEqual([
      [0, 7, "linear"], [0.5, 6, "linear"], [0.5, 1, "constant"], [1, 7, "linear"],
    ]);
  });

  it("adds keys for the visible axes only", () => {
    const onChange = vi.fn();
    render(<CurveEditor kind="vec3" aria-label="Sway" value={vector()} constraints={FIXED} channels={[true, false, false]}
      onChange={onChange} data-testid="curve" />);
    fireEvent.doubleClick(screen.getByTestId("curve-track"), { clientX: 25, clientY: 50 });
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.25, 1], [0.5, 7], [1, 7]]);
  });

  it("keeps every axis together on a Timeline track", () => {
    const onChange = vi.fn();
    render(<Stateful kind="vec3" initial={vector()} constraints={{ ...FIXED, sharedKeys: true }} onChange={onChange} />);
    drag("curve-key-1-x", 50, 70);
    expect(shape(onChange.mock.lastCall![0])).toEqual([[0, 7], [0.7, 7], [1, 7]]);
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
    act(() => {
      const handle = screen.getByTestId("curve-key-0");
      dispatchPointerEvent(handle, "pointerdown", { pointerType: "mouse", shiftKey: true });
      dispatchPointerEvent(handle, "pointerup", { pointerType: "mouse", shiftKey: true });
    });
    expect(screen.getByTestId("curve-key-count").textContent).toBe("2 Keys Selected");
  });

  it("drags a Color Curve's gradient stop in time only, and selects its key", () => {
    const onChange = vi.fn();
    const red = { x: 1, y: 0, z: 0, w: 1 };
    const blue = { x: 0, y: 0, z: 1, w: 0.5 };
    render(<Window kind="color" initial={curve(key(0, red, "linear", red), key(1, blue, "linear", blue))} onChange={onChange} />);
    const stop = screen.getByTestId("curve-stop-1");
    // The window frames 0.12 s past each end, so the stop at 1 s sits at 1.12 / 1.24 of the plot.
    act(() => { dispatchPointerEvent(stop, "pointerdown", { clientX: (100 * 1.12) / 1.24, clientY: 50 }); });
    expect(screen.getByTestId("curve-key-count").textContent).toBe("Key 2 of 2");
    act(() => {
      dispatchPointerEvent(stop, "pointermove", { clientX: 50, clientY: 0 });
      dispatchPointerEvent(stop, "pointerup", { clientX: 50, clientY: 0 });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    // The middle of the plot is 0.5 s, and the colour stays.
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
