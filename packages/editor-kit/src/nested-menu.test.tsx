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

  it("selects a radio-group value without closing when closeOnClick is false", () => {
    const onValueChange = vi.fn();
    const { getByTestId } = render(
      <NestedMenu
        items={[
          {
            id: "shading",
            type: "radio-group",
            value: "pbr",
            closeOnClick: false,
            onValueChange,
            items: [
              { id: "pbr", label: "PBR", value: "pbr" },
              {
                id: "unlit",
                label: "Unlit",
                value: "unlit",
                testId: "radio-unlit",
              },
            ],
          },
        ]}
        trigger={<button type="button" data-testid="menu-trigger">Open</button>}
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    expect(getByTestId("context-menu-item-pbr").getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(getByTestId("radio-unlit"));
    expect(onValueChange).toHaveBeenCalledWith("unlit");
    expect(getByTestId("menu-content").getAttribute("data-closed")).toBeNull();
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

  it("lets contentClassName override trigger-width sizing", () => {
    const { getByTestId } = render(
      <NestedMenu
        items={[leaf()]}
        contentClassName="w-max min-w-56 whitespace-nowrap"
        trigger={<button type="button" data-testid="menu-trigger">Open</button>}
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    const classes = getByTestId("menu-content").className;
    expect(classes).toContain("w-max");
    expect(classes).toContain("min-w-56");
    expect(classes).toContain("whitespace-nowrap");
    expect(classes).not.toContain("w-(--anchor-width)");
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

  it("selects a radio-group value on the overlay without closing when closeOnClick is false", () => {
    const onValueChange = vi.fn();
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
                      id: "shading",
                      type: "radio-group",
                      value: "pbr",
                      closeOnClick: false,
                      onValueChange,
                      items: [
                        { id: "pbr", label: "PBR", value: "pbr" },
                        {
                          id: "unlit",
                          label: "Unlit",
                          value: "unlit",
                          testId: "radio-unlit",
                        },
                      ],
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
    fireEvent.click(getByTestId("radio-unlit"));
    expect(onValueChange).toHaveBeenCalledWith("unlit");
    expect(queryByTestId("context-menu-panel")).not.toBeNull();
  });
});
