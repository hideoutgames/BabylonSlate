import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RichTextAppearModesField } from "./rich-text-appear-modes-field";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";

afterEach(cleanup);

describe("RichTextAppearModesField", () => {
  it("combines different modes and makes Instant replace the combination", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextAppearModesField value={["fade"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Mode" }));
    expect(onChange).toHaveBeenLastCalledWith(["fade", "scale"]);
    rerender(<RichTextAppearModesField value={["fade", "scale"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Appear Modes Mode 2" }));
    const instant = await screen.findByRole("option", { name: "Instant" });
    act(() => {
      dispatchPointerEvent(instant, "pointerdown", { pointerType: "mouse" });
      dispatchPointerEvent(instant, "pointerup", { pointerType: "mouse" });
    });
    fireEvent.click(instant, { detail: 1 });
    expect(onChange).toHaveBeenLastCalledWith(["instant"]);
    rerender(<RichTextAppearModesField value={["instant"]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Add Mode" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    rerender(<RichTextAppearModesField value={[]} onChange={onChange} />);
    expect(screen.getByText("Off")).toBeTruthy();
  });
});
