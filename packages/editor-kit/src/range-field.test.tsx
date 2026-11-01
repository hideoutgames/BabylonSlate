import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RangeField } from "./range-field";
import { formatRangeSummary, type RangeFieldKind, type RangeFieldValue } from "./range-values";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(cleanup);

function Stateful({ kind, initial, onChange, onCommit }: {
  kind: RangeFieldKind;
  initial: RangeFieldValue;
  onChange?: (value: RangeFieldValue) => void;
  onCommit?: (value: RangeFieldValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RangeField
      kind={kind}
      aria-label="Spawn"
      value={value}
      sensitivity={1}
      onChange={(next) => { setValue(next); onChange?.(next); }}
      onCommit={onCommit}
      data-testid="range"
    />
  );
}

function type(testId: string, text: string) {
  const input = screen.getByTestId(testId);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

describe("RangeField", () => {
  it("swaps a typed Min that ends above Max, keeping Max's value as the new Min", () => {
    const onCommit = vi.fn();
    render(<Stateful kind="float" initial={{ Min: 2, Max: 5 }} onCommit={onCommit} />);
    type("range-min", "10");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith({ Min: 5, Max: 10 });
  });

  it("swaps a typed Max that ends below Min", () => {
    const onCommit = vi.fn();
    render(<Stateful kind="int" initial={{ Min: 2, Max: 5 }} onCommit={onCommit} />);
    type("range-max", "-1");
    expect(onCommit).toHaveBeenLastCalledWith({ Min: -1, Max: 2 });
  });

  it("pushes Max along while Min is dragged past it, and commits once per drag", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Stateful kind="float" initial={{ Min: 2, Max: 5 }} onChange={onChange} onCommit={onCommit} />);
    const scrub = screen.getByTestId("range-min-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { clientX: 0 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 6 });
    expect(onChange).toHaveBeenLastCalledWith({ Min: 8, Max: 8 });
    // Moving back restores Max: the push is measured from where the drag began.
    dispatchPointerEvent(scrub, "pointermove", { clientX: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ Min: 3, Max: 5 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 4 });
    dispatchPointerEvent(scrub, "pointerup", { clientX: 4 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith({ Min: 6, Max: 6 });
  });

  it("keeps Integer ranges whole", () => {
    const onCommit = vi.fn();
    render(<Stateful kind="int" initial={{ Min: 0, Max: 10 }} onCommit={onCommit} />);
    type("range-min", "3.7");
    expect(onCommit).toHaveBeenLastCalledWith({ Min: 4, Max: 10 });
  });

  it("collapses a Vector range to a summary that expands to one Min – Max pair per axis", () => {
    const onCommit = vi.fn();
    render(<Stateful kind="vec3" initial={{ Min: { x: -5, y: 0, z: -5 }, Max: { x: 5, y: 2, z: 5 } }} onCommit={onCommit} />);
    const toggle = screen.getByTestId("range-toggle");
    expect(toggle.textContent).toBe("−5.00, 0.00, −5.00 – 5.00, 2.00, 5.00");
    expect(screen.queryByTestId("range-y-min")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    type("range-y-min", "4");
    expect(onCommit).toHaveBeenLastCalledWith({ Min: { x: -5, y: 2, z: -5 }, Max: { x: 5, y: 4, z: 5 } });
  });
});

describe("formatRangeSummary", () => {
  it.each([
    ["int", { Min: 2, Max: 5 }, undefined, "2–5"],
    ["float", { Min: 1.5, Max: 3 }, "m/s", "1.50 m/s–3.00 m/s"],
    ["rotator", { Min: { pitch: 0, yaw: 0, roll: -45 }, Max: { pitch: 0, yaw: 0, roll: 45 } }, "deg",
      "0.00, 0.00, −45.00° – 0.00, 0.00, 45.00°"],
  ] as const)("formats a %s range", (kind, value, unit, expected) => {
    expect(formatRangeSummary(kind, value, unit)).toBe(expected);
  });
});
