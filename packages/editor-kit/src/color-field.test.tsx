import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ColorField,
  parseHexColor,
} from "./color-field";

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
      <ColorField
        value={[1, 0, 0]}
        onChange={() => {}}
        data-testid="tint"
      />,
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
});
