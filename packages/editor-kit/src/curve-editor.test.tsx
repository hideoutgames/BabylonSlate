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

const keysOf = (value: CurveEditorValue) => value.Keys as Array<{ Time: number; Value: unknown; ArriveTangent: unknown; LeaveTangent: unknown }>;

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

  it("hides tangent handles for keys that are not Custom", () => {
    render(<Stateful initial={curve(key(0, 0, "auto"), key(1, 10))} constraints={FIXED} onChange={vi.fn()} />);
    expect(screen.queryByTestId("curve-tangent-leave")).toBeNull();
  });

  it("pans by dragging empty space, zooms with Ctrl-wheel, and Fit restores the framed view", () => {
    render(<Stateful initial={curve(key(0, 0), key(1, 1))} onChange={vi.fn()} />);
    const times = () => ["curve-time-start", "curve-time-end"].map((id) => Number(screen.getByTestId(id).textContent));
    expect(times()).toEqual([-0.05, 1.05]);
    const track = screen.getByTestId("curve-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 25, clientY: 50 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 25, clientY: 50 });
    });
    const [panStart, panEnd] = times() as [number, number];
    expect(panStart).toBeGreaterThan(0.2);
    expect(panEnd - panStart).toBeCloseTo(1.1, 1);
    act(() => { track.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -200, clientX: 50, clientY: 50, cancelable: true })); });
    const [zoomStart, zoomEnd] = times() as [number, number];
    expect(zoomEnd - zoomStart).toBeLessThan(1);
    fireEvent.click(screen.getByTestId("curve-fit"));
    expect(times()).toEqual([-0.05, 1.05]);
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
