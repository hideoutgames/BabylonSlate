import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumberPromptDialog } from "./number-prompt-dialog";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

describe("NumberPromptDialog", () => {
  it("seeds the saved value and submits a changed number", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={onOpenChange}
        title="Grid Size"
        label="Grid Size"
        initialValue={1}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByTestId("number-prompt-input")).toHaveProperty(
      "value",
      "1",
    );
    fireEvent.change(screen.getByTestId("number-prompt-input"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("number-prompt-confirm"));
    expect(onSubmit).toHaveBeenCalledWith(4);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
