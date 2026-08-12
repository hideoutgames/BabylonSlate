import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NumericDragField } from "./numeric-drag-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

describe("NumericDragField", () => {
  afterEach(() => {
    cleanup();
  });

  it("scrubs the value by horizontal drag distance", () => {
    const onChange = vi.fn();
    render(
      <NumericDragField
        label="X"
        value={1}
        sensitivity={0.1}
        onChange={onChange}
        data-testid="field"
      />,
    );

    const scrub = screen.getByTestId("field-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { clientX: 100 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 150 });

    expect(onChange).toHaveBeenCalledWith(6);
  });

  it("reports drag begin and end once per gesture", () => {
    const onDragBegin = vi.fn();
    const onDragEnd = vi.fn();
    render(
      <NumericDragField
        label="X"
        value={0}
        sensitivity={1}
        onChange={() => {}}
        onDragBegin={onDragBegin}
        onDragEnd={onDragEnd}
        data-testid="field"
      />,
    );

    const scrub = screen.getByTestId("field-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { clientX: 0 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 5 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 9 });
    dispatchPointerEvent(scrub, "pointerup", { clientX: 9 });

    expect(onDragBegin).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith(9);
  });

  it("clamps scrubbed values to the configured range", () => {
    const onChange = vi.fn();
    render(
      <NumericDragField
        label="Scale"
        value={1}
        sensitivity={1}
        min={0}
        max={2}
        onChange={onChange}
        data-testid="field"
      />,
    );

    const scrub = screen.getByTestId("field-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { clientX: 0 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 100 });
    expect(onChange).toHaveBeenLastCalledWith(2);
    dispatchPointerEvent(scrub, "pointermove", { clientX: -100 });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("ignores pointer moves from an unrelated pointer", () => {
    const onChange = vi.fn();
    render(
      <NumericDragField label="X" value={0} onChange={onChange} data-testid="field" />,
    );
    const scrub = screen.getByTestId("field-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { pointerId: 1, clientX: 0 });
    dispatchPointerEvent(scrub, "pointermove", { pointerId: 2, clientX: 50 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
