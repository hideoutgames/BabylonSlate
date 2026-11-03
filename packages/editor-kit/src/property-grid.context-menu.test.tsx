import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyRow } from "./property-grid";
import { dispatchPointerEvent } from "./test-support/pointer-events";

// The copied value lives for the session, so each test starts from a fresh module.
let PropertyGrid: typeof import("./property-grid").PropertyGrid;
let useContextMenu: typeof import("./use-context-menu").useContextMenu;
let ContextMenuOverlay: typeof import("./context-menu-overlay").ContextMenuOverlay;

beforeEach(async () => {
  vi.resetModules();
  ({ PropertyGrid } = await import("./property-grid"));
  ({ useContextMenu } = await import("./use-context-menu"));
  ({ ContextMenuOverlay } = await import("./context-menu-overlay"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function numberRow(id: string, value: number, extra: Partial<Extract<PropertyRow, { kind: "number" }>> = {}): PropertyRow {
  return { kind: "number", id, label: id, value, onChange: () => {}, ...extra };
}

function menuItem(id: "copy" | "paste"): HTMLElement {
  return screen.getByTestId(`context-menu-item-property-${id}`);
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled");
}

/** Right-click a row's title, as the mouse does. */
function openMenuOn(id: string) {
  fireEvent.contextMenu(screen.getByText(id));
}

describe("PropertyGrid Copy and Paste", () => {
  it("copies a row's value and pastes it into a row that takes it, as one finished edit", () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <PropertyGrid
        rows={[
          numberRow("Speed", 7.5),
          numberRow("Limit", 1, { max: 5, onChange, onCommit }),
          { kind: "boolean", id: "Visible", label: "Visible", value: true, onChange: () => {} },
        ]}
      />,
    );
    openMenuOn("Limit");
    // Nothing is copied yet.
    expect(isDisabled(menuItem("copy"))).toBe(false);
    expect(isDisabled(menuItem("paste"))).toBe(true);
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });

    openMenuOn("Speed");
    fireEvent.click(menuItem("copy"));
    expect(writeText).toHaveBeenCalledWith("7.5");

    // A boolean row does not take a number.
    openMenuOn("Visible");
    expect(isDisabled(menuItem("paste"))).toBe(true);
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });

    openMenuOn("Limit");
    expect(isDisabled(menuItem("paste"))).toBe(false);
    fireEvent.click(menuItem("paste"));
    // Clamped to the row's range.
    expect(onChange).toHaveBeenCalledWith(5);
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it("keeps the copied value across grids and offers Paste only where it fits", () => {
    const onChange = vi.fn();
    const first = render(<PropertyGrid rows={[{ kind: "vector3", id: "Position", label: "Position", value: [1, 2, 3], onChange: () => {} }]} />);
    openMenuOn("Position");
    fireEvent.click(menuItem("copy"));
    first.unmount();

    render(
      <PropertyGrid
        rows={[
          { kind: "vector3", id: "Scale", label: "Scale", value: [1, 1, 1], onChange },
          { kind: "vector3", id: "Box", label: "Box", value: [0, 0, 1, 1], axes: ["X", "Y", "W", "H"], onChange: () => {} },
        ]}
      />,
    );
    openMenuOn("Box");
    expect(isDisabled(menuItem("paste"))).toBe(true);
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    openMenuOn("Scale");
    fireEvent.click(menuItem("paste"));
    expect(onChange).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("copies from a read-only grid but does not paste into it, and does not copy a mixed value", () => {
    const onChange = vi.fn();
    const view = render(<PropertyGrid readOnly rows={[numberRow("Health", 10, { onChange }), numberRow("Armor", 2, { mixed: true })]} />);
    openMenuOn("Armor");
    expect(isDisabled(menuItem("copy"))).toBe(true);
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    openMenuOn("Health");
    fireEvent.click(menuItem("copy"));
    openMenuOn("Health");
    expect(isDisabled(menuItem("paste"))).toBe(true);
    view.rerender(<PropertyGrid rows={[numberRow("Health", 10, { onChange })]} />);
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    openMenuOn("Health");
    expect(isDisabled(menuItem("paste"))).toBe(false);
  });

  it("opens on a long press, and leaves a text field being typed in to the browser's own menu", () => {
    vi.useFakeTimers();
    render(<PropertyGrid rows={[{ kind: "text", id: "Name", label: "Name", value: "Hero", onChange: () => {} }]} />);
    const label = screen.getByText("Name");
    act(() => dispatchPointerEvent(label, "pointerdown", { pointerType: "touch" }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("property-context-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    vi.useRealTimers();

    const input = screen.getByTestId("property-Name");
    input.focus();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("property-context-menu")).toBeNull();
  });

  it("opens only the row's menu inside another menu's surface, by right-click or long press", () => {
    function ListRow() {
      const { menu, closeMenu, bind } = useContextMenu({ items: [{ id: "row-delete", label: "Delete", onSelect: () => {} }] });
      return (
        <div {...bind} data-testid="list-row">
          <PropertyGrid rows={[numberRow("Inner", 2)]} />
          {menu ? <ContextMenuOverlay menu={menu} onClose={closeMenu} contentTestId="list-row-menu" /> : null}
        </div>
      );
    }
    vi.useFakeTimers();
    render(<ListRow />);
    act(() => dispatchPointerEvent(screen.getByText("Inner"), "pointerdown", { pointerType: "touch" }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("property-context-menu")).toBeTruthy();
    expect(screen.queryByTestId("list-row-menu")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    act(() => dispatchPointerEvent(screen.getByText("Inner"), "pointerup", { pointerType: "touch" }));
    openMenuOn("Inner");
    expect(screen.queryByTestId("list-row-menu")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("property-context-menu"), { key: "Escape" });
    // Outside every row, the surface's own menu still opens.
    fireEvent.contextMenu(screen.getByTestId("list-row"));
    expect(screen.getByTestId("list-row-menu")).toBeTruthy();
  });
});
