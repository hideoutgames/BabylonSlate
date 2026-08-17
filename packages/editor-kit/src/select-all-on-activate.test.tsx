import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { selectInputContents, useSelectAllOnActivate } from "./select-all-on-activate";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function Host() {
  const selectAll = useSelectAllOnActivate();
  return <input data-testid="field" defaultValue="12.5" {...selectAll} />;
}

async function expectSelected(input: HTMLInputElement): Promise<void> {
  await waitFor(() => {
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
}

function activateWithPointer(input: HTMLInputElement): void {
  dispatchPointerEvent(input, "pointerdown", { pointerType: "touch" });
  input.focus();
}

describe("selectInputContents", () => {
  it("selects the current value", () => {
    const input = document.createElement("input");
    input.value = "abc";
    document.body.append(input);
    selectInputContents(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
    input.remove();
  });

  it("ignores controls that cannot select", () => {
    const input = document.createElement("input");
    input.select = () => {
      throw new Error("cannot select");
    };
    expect(() => selectInputContents(input)).not.toThrow();
  });
});

describe("useSelectAllOnActivate", () => {
  afterEach(() => {
    cleanup();
  });

  it("selects all text when the field is focused without a pointer", async () => {
    render(<Host />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    await expectSelected(input);
  });

  it("re-selects after the focusing pointerup places the caret", async () => {
    render(<Host />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    activateWithPointer(input);
    input.setSelectionRange(2, 2);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });
    await expectSelected(input);
  });

  it("does not re-select on a later pointerup while already focused", async () => {
    render(<Host />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    activateWithPointer(input);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });
    await expectSelected(input);
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    input.setSelectionRange(2, 2);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("does not re-select when a pointer arrives after keyboard focus", async () => {
    render(<Host />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    input.focus();
    await expectSelected(input);
    input.setSelectionRange(2, 2);
    dispatchPointerEvent(input, "pointerup", { pointerType: "mouse" });
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("re-selects after the focusing mouseup", async () => {
    render(<Host />);
    const input = screen.getByTestId("field") as HTMLInputElement;
    activateWithPointer(input);
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await expectSelected(input);
  });
});
