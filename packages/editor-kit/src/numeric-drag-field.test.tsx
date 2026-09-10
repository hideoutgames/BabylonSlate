import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NumericDragField } from "./numeric-drag-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function StatefulField({
  initial,
  onChange,
  onDragEnd,
}: {
  initial: number;
  onChange?: (value: number) => void;
  onDragEnd?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumericDragField
      label="X"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      onDragEnd={onDragEnd}
      data-testid="field"
    />
  );
}

describe("NumericDragField", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Mixed until a shared value is entered", () => {
    const onChange = vi.fn();
    render(
      <NumericDragField
        value={2}
        mixed
        onChange={onChange}
        data-testid="field"
      />,
    );
    const input = screen.getByTestId("field") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Mixed");
    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("explains a rejected expression on blur and clears the feedback when corrected", () => {
    render(
      <NumericDragField
        label="Scale"
        value={3}
        onChange={() => {}}
        data-testid="field"
      />,
    );
    const input = screen.getByTestId("field") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1/" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(input);
    expect(input.value).toBe("3");
    expect(screen.getByRole("alert").textContent).toMatch(/expression/i);
    expect(input.getAttribute("aria-describedby")).toBe(
      screen.getByRole("alert").id,
    );
    fireEvent.change(input, { target: { value: "6" } });
    expect(screen.queryByRole("alert")).toBeNull();
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
      <NumericDragField
        label="X"
        value={0}
        onChange={onChange}
        data-testid="field"
      />,
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
    expect(input.inputMode).toBe("text");

    dispatchPointerEvent(input, "pointerdown", { pointerType: "touch" });
    input.focus();
    input.setSelectionRange(2, 2);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });

    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });

  it("shows at most two decimal places while idle", () => {
    render(
      <NumericDragField
        label="X"
        value={1.22338899332}
        onChange={() => {}}
        data-testid="field"
      />,
    );
    expect((screen.getByTestId("field") as HTMLInputElement).value).toBe(
      "1.22",
    );
  });

  it("commits a complete arithmetic expression and shows two decimals after blur", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={1} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1+2" } });
    expect(input.value).toBe("1+2");
    expect(onChange).toHaveBeenCalledWith(3);

    fireEvent.blur(input);
    expect(input.value).toBe("3");
  });

  it("shows the evaluated result on Enter and ends the edit once", () => {
    const onDragEnd = vi.fn();
    render(<StatefulField initial={30} onDragEnd={onDragEnd} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/2" } });
    expect(input.value).toBe("30/2");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("15");
    expect(onDragEnd).toHaveBeenCalledExactlyOnceWith(15);

    input.focus();
    fireEvent.change(input, { target: { value: "/3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("5");
    expect(onDragEnd).toHaveBeenLastCalledWith(5);
  });

  it("restores the last value with feedback when Enter finishes an invalid expression", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={30} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("30");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/expression/i);
  });

  it("keeps editing when Enter confirms IME composition", () => {
    const onDragEnd = vi.fn();
    render(<StatefulField initial={30} onDragEnd={onDragEnd} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/2" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input.value).toBe("30/2");
    expect(document.activeElement).toBe(input);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("applies a leading * to the value from when editing started", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={1.5} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "*" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "*2" } });
    expect(onChange).toHaveBeenCalledWith(3);

    fireEvent.blur(input);
    expect(input.value).toBe("3");
  });

  it("does not commit an incomplete formula and restores the previous display on blur", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={1.5} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1+" } });
    expect(input.value).toBe("1+");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(input.value).toBe("1.5");
    expect(onChange).not.toHaveBeenCalled();
  });
});
