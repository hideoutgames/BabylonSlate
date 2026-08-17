import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("does not commit zero when the typed draft is emptied", () => {
    const onChange = vi.fn();
    render(
      <NumericDragField
        label="X"
        value={60}
        onChange={onChange}
        data-testid="field"
      />,
    );
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(input.value).toBe("60");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects the value on tap so typing overwrites it", async () => {
    render(
      <NumericDragField
        label="X"
        value={12.5}
        onChange={() => {}}
        data-testid="field"
      />,
    );
    const input = screen.getByTestId("field") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("decimal");

    dispatchPointerEvent(input, "pointerdown", { pointerType: "touch" });
    input.focus();
    input.setSelectionRange(2, 2);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });

    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });
});
