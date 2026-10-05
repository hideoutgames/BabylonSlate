import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorPicker, type ColorPickerProps } from "./color-picker";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Select Color" }));
}

describe("ColorPicker", () => {
  it("preserves authored precision on an unchanged Done and commits RGB once with untouched alpha", async () => {
    const onChange = vi.fn();
    function Controlled() {
      const [value, setValue] = useState<ColorPickerProps["value"]>([0.123456789, 0.654321987, 0.333333333, 0.456789123]);
      return <ColorPicker value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
    }
    render(<Controlled />);
    const trigger = screen.getByRole("button", { name: "Select Color" });
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    openPicker();
    fireEvent.change(screen.getByRole("textbox", { name: "Hex" }), { target: { value: "#00f" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([0, 0, 1, 0.456789123]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("discards Cancel and Escape drafts and returns focus without leaking editing keys to the graph", async () => {
    const onChange = vi.fn();
    const onGraphKey = vi.fn();
    render(<div onKeyDown={onGraphKey}><ColorPicker value={[1, 0, 0, 1]} onChange={onChange} /></div>);
    const trigger = screen.getByRole("button", { name: "Select Color" });
    openPicker();
    fireEvent.change(screen.getByRole("textbox", { name: "Hex" }), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openPicker();
    const hex = screen.getByRole("textbox", { name: "Hex" }) as HTMLInputElement;
    expect(hex.value).toBe("#ff0000");
    act(() => hex.focus());
    fireEvent.keyDown(hex, { key: "Backspace" });
    fireEvent.keyDown(hex, { key: "Delete" });
    fireEvent.keyDown(hex, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(hex, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onGraphKey).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("edits saturation and brightness through pointer coordinates and commits the final color once", () => {
    const onChange = vi.fn();
    render(<ColorPicker value={[1, 0, 0, 0.625]} onChange={onChange} />);
    openPicker();
    const palette = screen.getByRole("slider", { name: "Saturation And Brightness" });
    vi.spyOn(palette, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100, toJSON: () => ({}) });
    act(() => {
      dispatchPointerEvent(palette, "pointerdown", { pointerType: "mouse", clientX: 210, clientY: 20 });
      dispatchPointerEvent(palette, "pointermove", { pointerType: "mouse", clientX: 110, clientY: 45 });
      dispatchPointerEvent(palette, "pointerup", { pointerType: "mouse", clientX: 110, clientY: 45 });
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([0.75, 0.375, 0.375, 0.625]);
  });

  it("restores a cancelled palette gesture and offers keyboard saturation, brightness, and hue controls", async () => {
    // Inset slider thumbs become accessible once their track has a measured size.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 20));
    const onChange = vi.fn();
    render(<ColorPicker value={[1, 0, 0, 1]} onChange={onChange} withAlpha={false} />);
    openPicker();
    const palette = screen.getByRole("slider", { name: "Saturation And Brightness" });
    vi.spyOn(palette, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) });
    act(() => {
      dispatchPointerEvent(palette, "pointerdown", { clientX: 0, clientY: 100 });
      dispatchPointerEvent(palette, "pointercancel");
    });
    expect((screen.getByRole("textbox", { name: "Hex" }) as HTMLInputElement).value).toBe("#ff0000");
    fireEvent.keyDown(palette, { key: "Home" });
    fireEvent.keyDown(palette, { key: "ArrowDown", shiftKey: true });
    expect((screen.getByRole("textbox", { name: "Hex" }) as HTMLInputElement).value).toBe("#e6e6e6");
    fireEvent.keyDown(palette, { key: "End" });
    fireEvent.keyDown(palette, { key: "ArrowUp", shiftKey: true });
    const hue = await screen.findByRole("slider", { name: "Hue" });
    fireEvent.change(hue, { target: { value: "120" } });
    expect(screen.queryByRole("textbox", { name: "Alpha Value" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([0, 1, 0, 1]);
  });

  it("blocks invalid drafts and preserves RGB precision when changing alpha", () => {
    const onChange = vi.fn();
    render(<ColorPicker value={[0.123456789, 0.654321987, 0.333333333, 1]} onChange={onChange} />);
    openPicker();
    const hex = screen.getByRole("textbox", { name: "Hex" });
    fireEvent.change(hex, { target: { value: "#ff" } });
    expect(screen.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(true);
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openPicker();
    const alpha = screen.getByRole("textbox", { name: "Alpha Value" });
    fireEvent.change(alpha, { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(alpha, { target: { value: "0.432198765" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([0.123456789, 0.654321987, 0.333333333, 0.432198765]);
  });

  it("discards an open draft when the authoritative value changes or the control becomes disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ColorPicker value={[1, 0, 0, 1]} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByRole("textbox", { name: "Hex" }), { target: { value: "#000" } });
    rerender(<ColorPicker value={[0, 0, 1, 1]} onChange={onChange} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openPicker();
    expect((screen.getByRole("textbox", { name: "Hex" }) as HTMLInputElement).value).toBe("#0000ff");
    rerender(<ColorPicker value={[0, 0, 1, 1]} onChange={onChange} disabled />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Select Color" }).hasAttribute("disabled")).toBe(true);
    rerender(<ColorPicker value={[0, 0, 1, 1]} onChange={onChange} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
