import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { NestedMenu, type NestedMenuItem } from "./nested-menu";
import { ContextMenuOverlay } from "./context-menu-overlay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
        trigger={
          <button type="button" data-testid="menu-trigger">
            Open
          </button>
        }
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    expect(getByTestId("menu-content")).toBeTruthy();

    fireEvent.click(getByTestId("context-menu-item-more"));
    expect(getByTestId("context-menu-sub-more")).toBeTruthy();

    fireEvent.click(getByTestId("context-menu-item-duplicate"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(
      getByTestId("menu-content").getAttribute("data-closed"),
    ).not.toBeNull();
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
        trigger={
          <button type="button" data-testid="menu-trigger">
            Open
          </button>
        }
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
        trigger={
          <button type="button" data-testid="menu-trigger">
            Open
          </button>
        }
        contentTestId="menu-content"
      />,
    );

    fireEvent.click(getByTestId("menu-trigger"));
    expect(
      getByTestId("context-menu-item-pbr").getAttribute("aria-checked"),
    ).toBe("true");
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
        trigger={
          <button type="button" data-testid="menu-trigger">
            Open
          </button>
        }
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
        trigger={
          <button type="button" data-testid="menu-trigger">
            Open
          </button>
        }
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
  function KeyboardMenu({ items }: { items: NestedMenuItem[] }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          data-testid="keyboard-trigger"
          onClick={() => setOpen(true)}
        >
          Project Actions
        </button>
        <input data-testid="next-control" aria-label="Project Name" />
        <ContextMenuOverlay
          menu={open ? { open: true, x: 20, y: 20, items } : null}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }

  it("focuses enabled items, navigates by keyboard, and returns focus on Escape", async () => {
    const view = render(
      <StrictMode>
        <KeyboardMenu
          items={[
            {
              id: "disabled",
              label: "Disabled",
              disabled: true,
              onSelect: vi.fn(),
            },
            { id: "open", label: "Open", onSelect: vi.fn() },
            { id: "edit", label: "Edit", onSelect: vi.fn() },
            { id: "remove", label: "Delete", onSelect: vi.fn() },
          ]}
        />
      </StrictMode>,
    );
    const trigger = view.getByTestId("keyboard-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    const first = view.getByTestId("context-menu-item-open");
    const last = view.getByTestId("context-menu-item-remove");
    await act(async () => {});
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      view.getByTestId("context-menu-item-edit"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(view.queryByTestId("context-menu-panel")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("enters and leaves a submenu with arrows and restores the original trigger on Escape", async () => {
    const view = render(
      <KeyboardMenu
        items={[
          { id: "more", type: "submenu", label: "More", items: [leaf()] },
        ]}
      />,
    );
    const trigger = view.getByTestId("keyboard-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    const submenuTrigger = view.getByTestId("context-menu-item-more");
    fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      view.getByTestId("context-menu-item-duplicate"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(view.queryByTestId("context-menu-sub-more")).toBeNull();
    expect(document.activeElement).toBe(submenuTrigger);
    fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByTestId("context-menu-panel")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("preserves focus moved by a selected action instead of stealing it back", async () => {
    const view = render(
      <KeyboardMenu
        items={[
          leaf(() => {
            (
              document.querySelector(
                '[data-testid="next-control"]',
              ) as HTMLElement
            ).focus();
          }),
        ]}
      />,
    );
    const trigger = view.getByTestId("keyboard-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(view.getByTestId("context-menu-item-duplicate"));
    expect(view.queryByTestId("context-menu-panel")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByTestId("next-control")),
    );
  });

  it("leaves focus with the next screen when selection removes the original trigger", async () => {
    function ReplacingScreen() {
      const [selected, setSelected] = useState(false);
      return selected ? (
        <input autoFocus aria-label="New Screen" />
      ) : (
        <KeyboardMenu items={[leaf(() => setSelected(true))]} />
      );
    }
    const view = render(<ReplacingScreen />);
    const trigger = view.getByTestId("keyboard-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(view.getByTestId("context-menu-item-duplicate"));
    await act(async () => {});
    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).toBe(view.getByLabelText("New Screen"));
  });

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

  it("repositions an open overlay when safe-area tokens change", async () => {
    const values: Record<string, string> = {
      "--safe-top": "0px",
      "--safe-right": "0px",
      "--safe-bottom": "0px",
      "--safe-left": "0px",
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => values[name] ?? "",
        }) as CSSStyleDeclaration,
    );
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    try {
      render(
        <ContextMenuOverlay
          menu={{
            open: true,
            x: 900,
            y: 80,
            items: [leaf()],
          }}
          onClose={() => undefined}
        />,
      );

      const panel = document.querySelector(
        '[data-testid="context-menu-panel"]',
      ) as HTMLElement;
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
        width: 192,
        height: 40,
      } as DOMRect);
      await waitFor(() => expect(panel.style.left).toBe("900px"));

      values["--safe-right"] = "200px";
      fireEvent(window, new Event("resize"));

      await waitFor(() => expect(panel.style.left).toBe("800px"));
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  it("repositions an open root menu and submenu when only the viewport shrinks", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    try {
      render(
        <ContextMenuOverlay
          menu={{
            open: true,
            x: 900,
            y: 600,
            items: [
              { id: "more", type: "submenu", label: "More", items: [leaf()] },
            ],
          }}
          onClose={() => undefined}
        />,
      );
      const panel = document.querySelector(
        '[data-testid="context-menu-panel"]',
      ) as HTMLElement;
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
        width: 192,
        height: 120,
      } as DOMRect);
      fireEvent.click(
        document.querySelector('[data-testid="context-menu-item-more"]')!,
      );

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 700,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 500,
      });
      fireEvent(window, new Event("resize"));

      await waitFor(() => expect(panel.style.left).toBe("500px"));
      await waitFor(() => expect(panel.style.top).toBe("372px"));
      const submenu = document.querySelector(
        '[data-testid="context-menu-sub-more"]',
      ) as HTMLElement;
      await waitFor(() =>
        expect(Number.parseFloat(submenu.style.left)).toBeLessThan(500),
      );
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
    }
  });
});
