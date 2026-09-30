import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArrayProperty } from "./array-property";

afterEach(cleanup);

const options = [
  { id: "red", label: "Red", value: "red" },
  { id: "green", label: "Green", value: "green" },
  { id: "blue", label: "Blue", value: "blue" },
];

describe("ArrayProperty", () => {
  it("adds only unused choices, preserves order on move, and allows clearing the array", () => {
    const onChange = vi.fn();
    const props = { label: "Colors", options, onChange, unique: true };
    const { rerender } = render(<ArrayProperty {...props} value={["green"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    expect(onChange).toHaveBeenLastCalledWith(["green", "red"]);
    rerender(<ArrayProperty {...props} value={["green", "red", "blue"]} />);
    expect(screen.getByRole("button", { name: "Add Item" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Move row 3 up" }));
    expect(onChange).toHaveBeenLastCalledWith(["green", "blue", "red"]);
    rerender(<ArrayProperty {...props} value={["green"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("blocks duplicate and incompatible replacements while allowing a new choice", async () => {
    const onChange = vi.fn();
    render(<ArrayProperty label="Colors" value={["red", "green"]} options={options} unique onChange={onChange}
      isOptionAllowed={(item, index) => item !== "blue" || index === 0} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Colors Item 1" }));
    expect((await screen.findByRole("option", { name: "Green" })).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Green" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Blue" }));
    expect(onChange).toHaveBeenLastCalledWith(["blue", "green"]);
  });

  it("uses value identity for object arrays and disables Add when no compatible item remains", () => {
    const onChange = vi.fn();
    const props = {
      label: "Targets", options: [{ id: "a", label: "First", value: { id: "a" } }, { id: "b", label: "Second", value: { id: "b" } }],
      onChange, isEqual: (left: { id: string }, right: { id: string }) => left.id === right.id,
      isOptionAllowed: (item: { id: string }) => item.id !== "b", unique: true,
      defaultValue: [],
    };
    render(<ArrayProperty {...props} value={[{ id: "a" }]} />);
    expect(screen.getByRole("combobox", { name: "Targets Item 1" }).textContent).toContain("First");
    expect(screen.getByRole("button", { name: "Add Item" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Reset Targets" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("honors item limits and prevents edits while the property is disabled", () => {
    const onChange = vi.fn();
    const props = { label: "Colors", options, onChange, value: ["red"], defaultValue: [] };
    const { rerender } = render(<ArrayProperty {...props} minItems={1} maxItems={1} />);
    expect(screen.getByRole("button", { name: "Remove row 1" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add Item" })).toHaveProperty("disabled", true);
    rerender(<ArrayProperty {...props} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Colors" }));
    expect(screen.getByRole("combobox", { name: "Colors Item 1" })).toHaveProperty("disabled", true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
