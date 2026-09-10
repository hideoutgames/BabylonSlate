import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NumberField } from "./number-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function StatefulField({
  initial,
  min,
  onChange,
}: {
  initial: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumberField
      value={value}
      min={min}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      data-testid="field"
    />
  );
}

describe("NumberField", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the field empty while typing and does not commit empty", () => {
    const onChange = vi.fn();
    render(<NumberField value={60} onChange={onChange} data-testid="field" />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "6" } });
    expect(onChange).toHaveBeenCalledWith(6);

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("commits a new value typed after emptying", () => {
    const onChange = vi.fn();
    render(<NumberField value={60} onChange={onChange} data-testid="field" />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.change(input, { target: { value: "30" } });

    expect(onChange).toHaveBeenCalledWith(3);
    expect(onChange).toHaveBeenCalledWith(30);
    expect(onChange).not.toHaveBeenCalledWith(60);
  });

  it("restores the last committed value when blurred empty", () => {
    const onChange = vi.fn();
    render(<NumberField value={60} onChange={onChange} data-testid="field" />);
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(input.value).toBe("60");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit out-of-range drafts until blur, then clamps", () => {
    const onChange = vi.fn();
    render(
      <NumberField
        value={1}
        min={0.25}
        onChange={onChange}
        data-testid="field"
      />,
    );
    const input = screen.getByTestId("field") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "0" } });
    expect(input.value).toBe("0");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "0.5" } });
    expect(onChange).toHaveBeenCalledWith(0.5);

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(0.25);
    expect(screen.getByRole("status").textContent).toContain("0.25");
    expect(input.getAttribute("aria-describedby")).toBe(
      screen.getByRole("status").id,
    );
  });

  it("selects the value on tap so typing overwrites it", async () => {
    render(
      <NumberField value={12.5} onChange={() => {}} data-testid="field" />,
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

  it("replaces arithmetic with its result on Enter and uses it for the next edit", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={30} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/2" } });
    expect(input.value).toBe("30/2");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("15");
    expect(onChange).toHaveBeenLastCalledWith(15);

    input.focus();
    fireEvent.change(input, { target: { value: "/3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("5");
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it("clamps an out-of-range expression on Enter and explains the adjustment", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={30} min={10} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/6" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("10");
    expect(onChange).toHaveBeenLastCalledWith(10);
    expect(screen.getByRole("status").textContent).toContain("10");
  });

  it("restores invalid arithmetic on Enter without committing a value", () => {
    const onChange = vi.fn();
    render(<StatefulField initial={30} onChange={onChange} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("30");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/expression/i);
  });

  it("does not finish a numeric draft when Enter confirms IME composition", () => {
    render(<StatefulField initial={30} onChange={() => {}} />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "30/2" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input.value).toBe("30/2");
    expect(document.activeElement).toBe(input);
  });
});
