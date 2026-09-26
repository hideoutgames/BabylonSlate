import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurveField, type CurveFieldProps, type CurveKey } from "./curve-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
});

function StatefulCurve({
  initial,
  onChange,
  ...props
}: Omit<CurveFieldProps, "value" | "onChange" | "aria-label"> & {
  initial: CurveKey[];
  onChange?: (keys: CurveKey[]) => void;
}) {
  const [keys, setKeys] = useState(initial);
  return (
    <CurveField
      aria-label="Size"
      value={keys}
      onChange={(next) => {
        onChange?.(next);
        setKeys(next);
      }}
      defaultExpanded
      data-testid="size"
      {...props}
    />
  );
}

const key = (index: number) => screen.getByTestId(`size-key-${index}`);
const select = (index: number) => {
  act(() => {
    dispatchPointerEvent(key(index), "pointerdown");
    dispatchPointerEvent(key(index), "pointerup");
  });
};
const press = (index: number, init: { key: string; shiftKey?: boolean }, times = 1) => {
  for (let i = 0; i < times; i += 1) fireEvent.keyDown(key(index), init);
};

describe("CurveField", () => {
  it("adds a key in the widest gap on the curve and stops at the key limit", () => {
    const onChange = vi.fn();
    render(
      <StatefulCurve
        initial={[
          { t: 0, value: 0 },
          { t: 0.2, value: 1 },
          { t: 1, value: 3 },
        ]}
        maxKeys={4}
        onChange={onChange}
      />,
    );

    const add = screen.getByRole("button", { name: "Add Key" }) as HTMLButtonElement;
    fireEvent.click(add);
    expect(onChange).toHaveBeenLastCalledWith([
      { t: 0, value: 0 },
      { t: 0.2, value: 1 },
      { t: 0.6, value: 2 },
      { t: 1, value: 3 },
    ]);
    expect(key(2).getAttribute("aria-pressed")).toBe("true");
    expect(add.disabled).toBe(true);
  });

  it("keeps endpoints and the minimum key count", () => {
    render(
      <StatefulCurve
        initial={[
          { t: 0, value: 0 },
          { t: 0.5, value: 1 },
          { t: 1, value: 0 },
        ]}
        minKeys={2}
      />,
    );
    const remove = screen.getByRole("button", { name: "Remove Key" }) as HTMLButtonElement;

    select(0);
    expect(remove.disabled).toBe(true);
    select(1);
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(screen.queryByTestId("size-key-2")).toBeNull();

    // Two keys remain, both endpoints: nothing more can be removed.
    select(1);
    press(1, { key: "Delete" });
    expect(screen.getByTestId("size-key-1")).toBeTruthy();
    expect(remove.disabled).toBe(true);
  });

  it("clamps keyboard nudges between neighbours and to the value range", () => {
    const onChange = vi.fn();
    render(
      <StatefulCurve
        initial={[
          { t: 0, value: 0 },
          { t: 0.5, value: 1 },
          { t: 1, value: 0 },
        ]}
        valueMin={0}
        valueMax={2}
        onChange={onChange}
      />,
    );
    const lastKeys = () => onChange.mock.lastCall?.[0] as CurveKey[];

    press(1, { key: "ArrowRight", shiftKey: true }, 6);
    expect(lastKeys()[1]!.t).toBe(0.99);
    press(1, { key: "ArrowLeft", shiftKey: true }, 12);
    expect(lastKeys()[1]!.t).toBe(0.01);

    press(1, { key: "ArrowUp", shiftKey: true }, 8);
    expect(lastKeys()[1]!.value).toBe(2);
    press(1, { key: "ArrowDown", shiftKey: true }, 12);
    expect(lastKeys()[1]!.value).toBe(0);

    press(0, { key: "ArrowRight" });
    expect(lastKeys()[0]!.t).toBe(0);
    press(0, { key: "Delete" });
    expect(screen.getByTestId("size-key-2")).toBeTruthy();

    press(1, { key: "Delete" });
    expect(lastKeys()).toEqual([
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ]);
  });
});
