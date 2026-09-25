import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  GradientField,
  type GradientFieldProps,
  type GradientStop,
} from "./gradient-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
});

function StatefulGradient({
  initial,
  onChange,
  ...props
}: Omit<GradientFieldProps, "value" | "onChange" | "aria-label"> & {
  initial: GradientStop[];
  onChange?: (stops: GradientStop[]) => void;
}) {
  const [stops, setStops] = useState(initial);
  return (
    <GradientField
      aria-label="Color"
      value={stops}
      onChange={(next) => {
        onChange?.(next);
        setStops(next);
      }}
      defaultExpanded
      data-testid="color"
      {...props}
    />
  );
}

function selectStop(index: number) {
  const stop = screen.getByTestId(`color-stop-${index}`);
  act(() => {
    dispatchPointerEvent(stop, "pointerdown");
    dispatchPointerEvent(stop, "pointerup");
  });
}

const RED: GradientStop = { t: 0, color: [1, 0, 0, 1] };
const GREEN: GradientStop = { t: 0.5, color: [0, 1, 0, 1] };
const BLUE: GradientStop = { t: 1, color: [0, 0, 1, 1] };

describe("GradientField", () => {
  it("edits only the selected stop's alpha in one change", () => {
    const onChange = vi.fn();
    render(<StatefulGradient initial={[RED, GREEN, BLUE]} onChange={onChange} />);

    selectStop(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Color Stop 2 Alpha" }), {
      target: { value: "0.25" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      RED,
      { t: 0.5, color: [0, 1, 0, 0.25] },
      BLUE,
    ]);
  });

  it("keeps an interior stop between its neighbours and endpoints in place", () => {
    const onChange = vi.fn();
    render(<StatefulGradient initial={[RED, GREEN, BLUE]} onChange={onChange} />);
    const lastStops = () => onChange.mock.lastCall?.[0] as GradientStop[];

    selectStop(1);
    const location = screen.getByRole("textbox", { name: "Color Stop 2 Location" });
    fireEvent.change(location, { target: { value: "2" } });
    expect(lastStops()[1]!.t).toBe(0.99);
    fireEvent.change(location, { target: { value: "-1" } });
    expect(lastStops()[1]!.t).toBe(0.01);

    fireEvent.keyDown(screen.getByTestId("color-stop-0"), { key: "ArrowRight", shiftKey: true });
    expect(lastStops()[0]!.t).toBe(0);
  });

  it("adds interpolated stops up to the maximum and removes interior stops down to the minimum", () => {
    const onChange = vi.fn();
    render(
      <StatefulGradient
        initial={[RED, { t: 1, color: [0, 0, 1, 0] }]}
        onChange={onChange}
      />,
    );
    const add = screen.getByRole("button", { name: "Add Stop" }) as HTMLButtonElement;
    const remove = screen.getByRole("button", { name: "Remove Stop" }) as HTMLButtonElement;

    expect(remove.disabled).toBe(true);
    fireEvent.click(add);
    expect(onChange).toHaveBeenLastCalledWith([
      RED,
      { t: 0.5, color: [0.5, 0, 0.5, 0.5] },
      { t: 1, color: [0, 0, 1, 0] },
    ]);

    for (let count = 3; count < 8; count += 1) fireEvent.click(add);
    expect(screen.getAllByRole("button", { name: /^Stop \d/ })).toHaveLength(8);
    expect(add.disabled).toBe(true);

    for (let count = 8; count > 2; count -= 1) {
      selectStop(1);
      fireEvent.click(remove);
    }
    expect(screen.getAllByRole("button", { name: /^Stop \d/ })).toHaveLength(2);
    selectStop(1);
    expect(remove.disabled).toBe(true);
  });
});
