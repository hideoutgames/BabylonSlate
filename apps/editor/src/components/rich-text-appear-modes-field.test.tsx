import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RichTextAppearModesField } from "./rich-text-appear-modes-field";

afterEach(cleanup);

describe("RichTextAppearModesField", () => {
  it("combines different modes and makes Instant replace the combination", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextAppearModesField value={["fade"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Mode" }));
    expect(onChange).toHaveBeenLastCalledWith(["fade", "scale"]);
    rerender(<RichTextAppearModesField value={["fade", "scale"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Appear Modes Mode 2" }));
    fireEvent.click(await screen.findByRole("option", { name: "Instant" }));
    expect(onChange).toHaveBeenLastCalledWith(["instant"]);
    rerender(<RichTextAppearModesField value={["instant"]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Add Mode" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    rerender(<RichTextAppearModesField value={[]} onChange={onChange} />);
    expect(screen.getByText("Off")).toBeTruthy();
  });
});
