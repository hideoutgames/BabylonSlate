import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Text2DAppearMode } from "@babylonslate/core";
import { RichTextAppearModesField } from "./rich-text-appear-modes-field";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";

afterEach(cleanup);

describe("RichTextAppearModesField", () => {
  it("keeps focus on Instant when choosing it removes preceding modes", async () => {
    function ControlledModes() {
      const [value, setValue] = useState<Text2DAppearMode[]>(["fade", "scale"]);
      return <RichTextAppearModesField value={value} onChange={setValue} />;
    }
    render(<ControlledModes />);
    const trigger = screen.getByRole("combobox", { name: "Appear Modes Mode 2" });
    trigger.focus();
    fireEvent.click(trigger);
    const instant = await screen.findByRole("option", { name: "Instant" });
    act(() => {
      dispatchPointerEvent(instant, "pointerdown", { pointerType: "mouse" });
      dispatchPointerEvent(instant, "pointerup", { pointerType: "mouse" });
    });
    fireEvent.click(instant, { detail: 1 });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Appear Modes Mode 1" })).toBe(trigger);
    expect(trigger.textContent).toContain("Instant");
  });

  it("resets to the supplied prefab modes or Off for class defaults", () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextAppearModesField value={["scale"]} defaultValue={["fade"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Appear Modes" }));
    expect(onChange).toHaveBeenLastCalledWith(["fade"]);
    rerender(<RichTextAppearModesField value={["fade"]} defaultValue={["fade"]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Reset Appear Modes" })).toHaveProperty("disabled", true);
    rerender(<RichTextAppearModesField value={["fade"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Appear Modes" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

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
