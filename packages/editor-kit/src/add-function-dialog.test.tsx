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

  it("renders Add Event copy and event test ids", () => {
    const onCreateEmpty = vi.fn();
    render(
      <AddFunctionDialog
        open
        onOpenChange={() => {}}
        title="Add Event"
        description="Create an empty custom event or override a native, inherited, or nested one."
        emptyLabel="New Empty Event"
        nameLabel="Event Name"
        items={[
          {
            id: "native:flow.event.beginPlay",
            name: "Event Begin Play",
            description: "Native",
            overwritten: true,
            kind: "native",
          },
          {
            id: "nested:chip-guid:On Chip",
            name: "On Chip",
            description: "Nested · Chip",
            overwritten: false,
            kind: "nested",
          },
        ]}
        onCreateEmpty={onCreateEmpty}
        onPick={() => {}}
        data-testid="add-event-dialog"
      />,
    );
    expect(screen.getByTestId("add-event-dialog").textContent).toContain(
      "Add Event",
    );
    expect(screen.getByTestId("add-event-empty").textContent).toContain(
      "New Empty Event",
    );
    expect(
      screen.getByTestId("add-event-item-native:flow.event.beginPlay")
        .textContent,
    ).toContain("Overwritten");
    fireEvent.change(screen.getByTestId("add-event-name"), {
      target: { value: "On Hit" },
    });
    fireEvent.click(screen.getByTestId("add-event-confirm"));
    expect(onCreateEmpty).toHaveBeenCalledWith("On Hit");
  });

  it("uses non-button option rows so a finger pan can scroll the list", () => {
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
        ]}
        onCreateEmpty={() => {}}
        onPick={() => {}}
      />,
    );
    const row = screen.getByTestId("add-function-item-interface:g:Apply Damage");
    expect(row.tagName).not.toBe("BUTTON");
    expect(row.getAttribute("role")).toBe("option");
    expect(row.className).toMatch(/touch-pan-y/);
    expect(screen.getByTestId("add-function-body").getAttribute("role")).toBe(
      "listbox",
    );
  });

  it("keeps the override list in a bounded scroll region", () => {
    render(
      <AddFunctionDialog
        open
        onOpenChange={() => {}}
        items={Array.from({ length: 24 }, (_, index) => ({
          id: `native:event-${index}`,
          name: `Event ${index}`,
          description: "Native",
          overwritten: false,
          kind: "native",
        }))}
        onCreateEmpty={() => {}}
        onPick={() => {}}
      />,
    );
    const list = screen.getByTestId("add-function-list");
    const scroller = list.closest("[data-testid='add-function-body']");
    expect(scroller).toBeTruthy();
    expect(scroller?.className).toMatch(/overflow-y-auto/);
    expect(scroller?.className).not.toMatch(/(?:^|\s)h-0(?:\s|$)/);
    expect(scroller?.className).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    expect(Number.parseFloat((scroller as HTMLElement).style.height)).toBe(256);
  });
});
