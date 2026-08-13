import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NestedMenu, type NestedMenuItem } from "./nested-menu";
import { ContextMenuOverlay } from "./context-menu-overlay";

afterEach(() => {
  cleanup();
});

const leaf = (onSelect = vi.fn()): NestedMenuItem => ({
  id: "duplicate",
  label: "Duplicate",
  onSelect,
});

describe("NestedMenu dropdown", () => {
  it("opens a submenu on tap and runs a leaf action", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <NestedMenu
        items={[
          {
            id: "more",
            type: "submenu",
            label: "More",
            items: [leaf(onSelect)],
          },
        ]}
        trigger={<button type="button" data-testid="menu-trigger">Open</button>}
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    expect(getByTestId("menu-content")).toBeTruthy();

    fireEvent.click(getByTestId("context-menu-item-more"));
    expect(getByTestId("context-menu-sub-more")).toBeTruthy();

    fireEvent.click(getByTestId("context-menu-item-duplicate"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(getByTestId("menu-content").getAttribute("data-closed")).not.toBeNull();
  });

  it("keeps the menu open when a checkbox sets closeOnClick false", () => {
    const onCheckedChange = vi.fn();
    const { getByTestId } = render(
      <NestedMenu
        items={[
          {
            id: "snap",
            type: "checkbox",
            label: "Snap",
            checked: false,
            closeOnClick: false,
            onCheckedChange,
          },
        ]}
        trigger={<button type="button" data-testid="menu-trigger">Open</button>}
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    fireEvent.click(getByTestId("context-menu-item-snap"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(getByTestId("menu-content")).toBeTruthy();
  });

  it("does not open a disabled submenu", () => {
    const { getByTestId, queryByTestId } = render(
      <NestedMenu
        items={[
          {
            id: "more",
            type: "submenu",
            label: "More",
            disabled: true,
            items: [leaf()],
          },
        ]}
        trigger={<button type="button" data-testid="menu-trigger">Open</button>}
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    fireEvent.click(getByTestId("context-menu-item-more"));
    expect(queryByTestId("context-menu-sub-more")).toBeNull();
  });
});

describe("NestedMenu context overlay", () => {
  it("renders nested items from ContextMenuOverlay and closes after a leaf select", () => {
    const onSelect = vi.fn();
    function OverlayHost() {
      const [open, setOpen] = useState(true);
      return (
        <ContextMenuOverlay
          menu={
            open
              ? {
                  open: true,
                  x: 40,
                  y: 80,
                  items: [
                    {
                      id: "more",
                      type: "submenu",
                      label: "More",
                      items: [leaf(onSelect)],
                    },
                  ],
                }
              : null
          }
          onClose={() => setOpen(false)}
        />
      );
    }
    const { getByTestId, queryByTestId } = render(<OverlayHost />);

    const panel = getByTestId("context-menu-panel");
    expect(panel.style.left).toBe("40px");
    expect(panel.style.top).toBe("80px");

    fireEvent.click(getByTestId("context-menu-item-more"));
    expect(getByTestId("context-menu-sub-more")).toBeTruthy();

    fireEvent.click(getByTestId("context-menu-item-duplicate"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(queryByTestId("context-menu-panel")).toBeNull();
  });
});
