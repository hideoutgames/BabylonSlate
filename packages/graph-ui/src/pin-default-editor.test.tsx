import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinDefaultEditor } from "./pin-default-editor";
import type { PinDefaultEditorRequest } from "./pin-default-editor-context";
import { pinDefaultPreview } from "./pin-default-preview";

afterEach(cleanup);

function request(kind: string, value: unknown, onChange: (value: unknown) => void = vi.fn()): PinDefaultEditorRequest {
  const pin = { id: "value", name: "Value", direction: "in" as const, kind: "data" as const, type: { kind } };
  return { nodeId: "node", nodeData: {}, pin, value, preview: pinDefaultPreview(pin, { "default:value": value }, false)!, disabled: false, onChange };
}

describe("inline default editing sessions", () => {
  it.each(["string", "float"])("discards an unfinished %s draft when an authoritative value changes", (kind) => {
    const initial = request(kind, kind === "string" ? "Before" : 2);
    const { rerender } = render(<PinDefaultEditor {...initial} />);
    const input = screen.getByRole("textbox", { name: "Value" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: kind === "string" ? "Uncommitted" : "7" } });
    expect(initial.onChange).not.toHaveBeenCalled();
    const incoming = kind === "string" ? "Undo" : 3;
    rerender(<PinDefaultEditor {...request(kind, incoming, initial.onChange)} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "Value" }));
    expect((screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).value).toBe(String(incoming));
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it.each(["string", "float"])("cancels a %s edit with Escape", (kind) => {
    const initial = request(kind, kind === "string" ? "Before" : 2);
    render(<PinDefaultEditor {...initial} />);
    const input = screen.getByRole("textbox", { name: "Value" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: kind === "string" ? "Uncommitted" : "7" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(initial.onChange).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).value).toBe(kind === "string" ? "Before" : "2");
  });

  it("ends a numeric scrub with one bounded commit without changing the graph during the gesture", () => {
    const initial = request("float", 0.5);
    initial.pin.min = 0;
    initial.pin.max = 1;
    render(<PinDefaultEditor {...initial} />);
    const scrub = screen.getByTestId("pin-default-node-value-scrub");
    const dispatch = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX });
      Object.defineProperty(event, "pointerId", { value: 1 });
      act(() => scrub.dispatchEvent(event));
    };
    dispatch("pointerdown", 0);
    dispatch("pointermove", 10);
    dispatch("pointermove", 100);
    expect(initial.onChange).not.toHaveBeenCalled();
    dispatch("pointerup", 100);
    expect(initial.onChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("commits an inline vector component once and preserves untouched full-precision axes", () => {
    const initial = request("vec3", { x: 1, y: 0.123456789, z: 3 });
    render(<PinDefaultEditor {...initial} />);
    const x = screen.getByRole("textbox", { name: "Value X" });
    fireEvent.change(x, { target: { value: "7" } });
    expect(initial.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.blur(x);
    expect(initial.onChange).toHaveBeenCalledExactlyOnceWith({ x: 7, y: 0.123456789, z: 3 });
  });

  it.each([
    ["vec2", ["X", "Y"]],
    ["vec3", ["X", "Y", "Z"]],
    ["vec4", ["X", "Y", "Z", "W"]],
    ["quat", ["X", "Y", "Z", "W"]],
    ["rotator", ["Pitch", "Yaw", "Roll"]],
  ] as const)("shows %s components directly on the pin", (kind, axes) => {
    render(<PinDefaultEditor {...request(kind, {})} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(axes.length);
    for (const axis of axes) expect(screen.getByRole("textbox", { name: `Value ${axis}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Value" })).toBeNull();
  });

  it("keeps the next vector component mounted while another component commits", () => {
    const initial = request("vec3", { x: 1, y: 2, z: 3 });
    const { rerender } = render(<PinDefaultEditor {...initial} />);
    const y = screen.getByRole("textbox", { name: "Value Y" });
    const x = screen.getByRole("textbox", { name: "Value X" });
    fireEvent.change(x, { target: { value: "7" } });
    fireEvent.blur(x);
    act(() => y.focus());
    rerender(<PinDefaultEditor {...request("vec3", { x: 7, y: 2, z: 3 }, initial.onChange)} />);
    expect(screen.getByRole("textbox", { name: "Value Y" })).toBe(y);
    expect(document.activeElement).toBe(y);
  });

  it("discards a vector component draft when read-only is enabled and does not revive it", () => {
    const initial = request("vec3", { x: 1, y: 2, z: 3 });
    const { rerender } = render(<PinDefaultEditor {...initial} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Value X" }), { target: { value: "7" } });
    rerender(<PinDefaultEditor {...initial} disabled />);
    expect(screen.getByRole("textbox", { name: "Value X" }).hasAttribute("disabled")).toBe(true);
    rerender(<PinDefaultEditor {...initial} />);
    expect((screen.getByRole("textbox", { name: "Value X" }) as HTMLInputElement).value).toBe("1");
    fireEvent.blur(screen.getByRole("textbox", { name: "Value X" }));
    expect(initial.onChange).not.toHaveBeenCalled();
  });

  it("opens the color palette directly and commits one RGBA value on Done", () => {
    const initial = request("color", { x: 1, y: 0, z: 0, w: 0.25 });
    render(<PinDefaultEditor {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Value" }));
    expect(screen.getByRole("slider", { name: "Saturation And Brightness" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Hex" }), { target: { value: "#123456" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Alpha Value" }), { target: { value: "0.5" } });
    expect(initial.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(initial.onChange).toHaveBeenCalledExactlyOnceWith({ x: 18 / 255, y: 52 / 255, z: 86 / 255, w: 0.5 });
  });

  it("uses the RGB-only picker for a material color-hinted Vector3", () => {
    const initial = request("vec3", { x: 1, y: 0, z: 0, w: 1 });
    initial.pin.colorHint = true;
    initial.preview = { kind: "color", rgb: "rgb(255, 0, 0)" };
    render(<PinDefaultEditor {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Value" }));
    expect(screen.getByRole("slider", { name: "Saturation And Brightness" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Alpha Value" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Hex" }), { target: { value: "#000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(initial.onChange).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("keeps editing events away from node dragging, navigation, and Delete shortcuts", () => {
    const graphPointerDown = vi.fn();
    const navigate = vi.fn();
    const graphKey = vi.fn();
    render(<div onPointerDown={graphPointerDown} onDoubleClick={navigate} onKeyDown={graphKey}>
      <PinDefaultEditor {...request("string", "Hello")} />
    </div>);
    const input = screen.getByRole("textbox", { name: "Value" });
    fireEvent.pointerDown(input);
    fireEvent.doubleClick(input);
    fireEvent.keyDown(input, { key: "Delete" });
    expect(graphPointerDown).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(graphKey).not.toHaveBeenCalled();
  });
});
