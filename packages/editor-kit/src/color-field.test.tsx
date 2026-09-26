import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ColorField, parseHexColor } from "./color-field";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
});

describe("parseHexColor", () => {
  it("parses hash, bare, and 3-digit hex into 0–1 RGB", () => {
    expect(parseHexColor("#00ff00")).toEqual([0, 1, 0]);
    expect(parseHexColor("00ff00")).toEqual([0, 1, 0]);
    expect(parseHexColor("  #0f0  ")).toEqual([0, 1, 0]);
    expect(parseHexColor("#f80")).toEqual([1, 136 / 255, 0]);
  });

  it("rejects incomplete or non-hex text", () => {
    expect(parseHexColor("#ff")).toBeUndefined();
    expect(parseHexColor("not-a-color")).toBeUndefined();
    expect(parseHexColor("")).toBeUndefined();
  });
});

describe("ColorField", () => {
  it("shows the committed hex next to the native picker", () => {
    render(
      <ColorField value={[1, 0, 0]} onChange={() => {}} data-testid="tint" />,
    );
    expect((screen.getByTestId("tint") as HTMLInputElement).value).toBe(
      "#ff0000",
    );
    expect((screen.getByTestId("tint-hex") as HTMLInputElement).value).toBe(
      "#ff0000",
    );
  });

  it("commits RGB from pasted or typed hex", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ColorField value={[1, 0, 0]} onChange={onChange} data-testid="tint" />,
    );
    const hex = () => screen.getByTestId("tint-hex") as HTMLInputElement;

    fireEvent.change(hex(), { target: { value: "#00ff00" } });
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 0]);
    rerender(
      <ColorField value={[0, 1, 0]} onChange={onChange} data-testid="tint" />,
    );

    fireEvent.change(hex(), { target: { value: "0000ff" } });
    expect(onChange).toHaveBeenLastCalledWith([0, 0, 1]);
    rerender(
      <ColorField value={[0, 0, 1]} onChange={onChange} data-testid="tint" />,
    );

    fireEvent.change(hex(), { target: { value: "#0f0" } });
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 0]);
  });

  it("keeps a partial hex draft and restores on blur", () => {
    const onChange = vi.fn();
    render(
      <ColorField value={[1, 0, 0]} onChange={onChange} data-testid="tint" />,
    );
    const hex = screen.getByTestId("tint-hex") as HTMLInputElement;

    fireEvent.change(hex, { target: { value: "#ff" } });
    expect(hex.value).toBe("#ff");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(hex);
    expect(hex.value).toBe("#ff0000");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/hex/i);
    expect(hex.getAttribute("aria-describedby")).toBe(
      screen.getByRole("alert").id,
    );
    fireEvent.change(hex, { target: { value: "#000" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers alpha only when set and keeps edits within 0–1", () => {
    const onAlphaChange = vi.fn();
    const { rerender } = render(
      <ColorField value={[1, 0, 0]} onChange={() => {}} aria-label="Tint" data-testid="tint" />,
    );
    expect(screen.queryByTestId("tint-alpha")).toBeNull();

    rerender(
      <ColorField
        value={[1, 0, 0]}
        onChange={() => {}}
        alpha={0.5}
        onAlphaChange={onAlphaChange}
        aria-label="Tint"
        data-testid="tint"
      />,
    );
    const alpha = screen.getByRole("textbox", { name: "Tint Alpha" }) as HTMLInputElement;
    expect(alpha.value).toBe("0.5");
    fireEvent.change(alpha, { target: { value: "2" } });
    expect(onAlphaChange).toHaveBeenLastCalledWith(1);
    fireEvent.change(alpha, { target: { value: "0.2" } });
    expect(onAlphaChange).toHaveBeenLastCalledWith(0.2);
  });

  it("commits from the native color picker", () => {
    const onChange = vi.fn();
    render(
      <ColorField value={[1, 0, 0]} onChange={onChange} data-testid="tint" />,
    );
    fireEvent.change(screen.getByTestId("tint"), {
      target: { value: "#0000ff" },
    });
    expect(onChange).toHaveBeenCalledWith([0, 0, 1]);
  });

  it("selects the hex value on tap so typing overwrites it", async () => {
    render(
      <ColorField value={[1, 0, 0]} onChange={() => {}} data-testid="tint" />,
    );
    const hex = screen.getByTestId("tint-hex") as HTMLInputElement;
    dispatchPointerEvent(hex, "pointerdown", { pointerType: "touch" });
    hex.focus();
    hex.setSelectionRange(1, 1);
    dispatchPointerEvent(hex, "pointerup", { pointerType: "touch" });

    await waitFor(() => {
      expect(hex.selectionStart).toBe(0);
      expect(hex.selectionEnd).toBe(hex.value.length);
    });
  });
});
