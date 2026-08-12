import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumberField } from "./number-field";

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
  });
});
