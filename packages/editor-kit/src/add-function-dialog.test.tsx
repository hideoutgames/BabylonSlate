import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddFunctionDialog } from "./add-function-dialog";

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

describe("AddFunctionDialog", () => {
  it("creates an empty function from the name field", () => {
    const onCreateEmpty = vi.fn();
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AddFunctionDialog
        open
        onOpenChange={onOpenChange}
        items={[
          {
            id: "interface:g:Apply Damage",
            name: "Apply Damage",
            description: "Interface · Damageable",
            overwritten: false,
            kind: "interface",
          },
          {
            id: "function:Pawn:Jump",
            name: "Jump",
            description: "Parent · Pawn",
            overwritten: true,
            kind: "function",
          },
        ]}
        onCreateEmpty={onCreateEmpty}
        onPick={onPick}
      />,
    );
    expect(screen.getByTestId("add-function-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-function-confirm"));
    expect(onCreateEmpty).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("add-function-name"), {
      target: { value: " Dash " },
    });
    fireEvent.click(screen.getByTestId("add-function-confirm"));
    expect(onCreateEmpty).toHaveBeenCalledWith("Dash");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks a live interface row and ignores overwritten rows", () => {
    const onCreateEmpty = vi.fn();
    const onPick = vi.fn();
    render(
      <AddFunctionDialog
        open
        onOpenChange={() => {}}
        items={[
          {
            id: "interface:g:Apply Damage",
            name: "Apply Damage",
            description: "Interface · Damageable",
            overwritten: false,
            kind: "interface",
          },
          {
            id: "function:Pawn:Jump",
            name: "Jump",
            description: "Parent · Pawn",
            overwritten: true,
            kind: "function",
          },
        ]}
        onCreateEmpty={onCreateEmpty}
        onPick={onPick}
      />,
    );
    expect(
      screen.getByTestId("add-function-item-function:Pawn:Jump").textContent,
    ).toContain("Overwritten");
    fireEvent.click(screen.getByTestId("add-function-item-function:Pawn:Jump"));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("add-function-item-interface:g:Apply Damage"),
    );
    expect(onPick).toHaveBeenCalledWith("interface:g:Apply Damage");
  });
});
