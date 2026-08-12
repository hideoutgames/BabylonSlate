import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
  resolveHoldPointerPhase,
  useContextMenu,
  type ContextMenuItem,
} from "./use-context-menu";
import { ContextMenuOverlay } from "./context-menu-overlay";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function TestHost({
  items,
  enabled = true,
}: {
  items: ContextMenuItem[];
  enabled?: boolean;
}) {
  const { menu, closeMenu, bind } = useContextMenu({ items, enabled });
  return (
    <div data-testid="target" {...bind}>
      <span data-testid="state">{menu?.open ? "open" : "closed"}</span>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
    </div>
  );
}

const ORIGIN = { clientX: 5, clientY: 5 };

function renderHost(items: ContextMenuItem[] = [
  { id: "a", label: "Action", onSelect: vi.fn() },
], enabled = true) {
  const utils = render(<TestHost items={items} enabled={enabled} />);
  return {
    ...utils,
    target: utils.getByTestId("target"),
    state: () => utils.getByTestId("state").textContent,
  };
}

async function advancePastLongPress(by = CONTEXT_MENU_LONG_PRESS_MS) {
  await act(async () => {
    vi.advanceTimersByTime(by);
  });
}

describe("useContextMenu", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens on contextmenu event and prevents the native menu", () => {
    const { target, state } = renderHost();
    const notPrevented = fireEvent.contextMenu(target, {
      clientX: 10,
      clientY: 20,
    });
    expect(state()).toBe("open");
    expect(notPrevented).toBe(false);
  });

  it("opens after a stationary long press from a touch pointer", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advancePastLongPress();
    expect(state()).toBe("open");
  });

  it("does not open before the long-press delay elapses", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advancePastLongPress(CONTEXT_MENU_LONG_PRESS_MS - 50);
    expect(state()).toBe("closed");
  });

  it("ignores mouse pointers so the contextmenu path owns them", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", {
      ...ORIGIN,
      pointerType: "mouse",
    });
    await advancePastLongPress();
    expect(state()).toBe("closed");
  });

  it("cancels the press when the pointer moves past tolerance", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    dispatchPointerEvent(target, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
      clientY: ORIGIN.clientY,
    });
    await advancePastLongPress();
    expect(state()).toBe("closed");
  });

  it("keeps the press armed for movement within tolerance", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    dispatchPointerEvent(target, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX - 1,
      clientY: ORIGIN.clientY,
    });
    await advancePastLongPress();
    expect(state()).toBe("open");
  });

  it("ignores movement from an unrelated pointer id", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();
    dispatchPointerEvent(target, "pointerdown", { ...ORIGIN, pointerId: 1 });
    dispatchPointerEvent(target, "pointermove", {
      pointerId: 2,
      clientX: 500,
      clientY: 500,
    });
    await advancePastLongPress();
    expect(state()).toBe("open");
  });

  it("cancels the press on pointerup and pointercancel", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost();

    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    dispatchPointerEvent(target, "pointerup", ORIGIN);
    await advancePastLongPress();
    expect(state()).toBe("closed");

    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    dispatchPointerEvent(target, "pointercancel", ORIGIN);
    await advancePastLongPress();
    expect(state()).toBe("closed");
  });

  it("cancels a pending press and closes an open menu on scroll", async () => {
    const { target, queryByTestId } = renderHost();
    fireEvent.contextMenu(target, { clientX: 1, clientY: 1 });
    expect(queryByTestId("context-menu-panel")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(queryByTestId("context-menu-panel")).toBeNull();
  });

  it("does nothing when there are no items", () => {
    const { target, state } = renderHost([]);
    fireEvent.contextMenu(target);
    expect(state()).toBe("closed");
  });

  it("does nothing when disabled", async () => {
    vi.useFakeTimers();
    const { target, state } = renderHost(
      [{ id: "a", label: "Action", onSelect: vi.fn() }],
      false,
    );
    fireEvent.contextMenu(target);
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advancePastLongPress();
    expect(state()).toBe("closed");
  });

  it("runs an item action and closes the menu on select", () => {
    const onSelect = vi.fn();
    const { target, getByTestId, queryByTestId } = renderHost([
      { id: "a", label: "Action", onSelect },
    ]);
    fireEvent.contextMenu(target, { clientX: 3, clientY: 4 });
    fireEvent.click(getByTestId("context-menu-item-a"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(queryByTestId("context-menu-panel")).toBeNull();
  });

  it("closes the menu when the backdrop is tapped", () => {
    const { target, getByTestId, queryByTestId } = renderHost();
    fireEvent.contextMenu(target);
    fireEvent.click(getByTestId("context-menu-backdrop"));
    expect(queryByTestId("context-menu-panel")).toBeNull();
  });

  it("positions the menu at the gesture coordinates", () => {
    const { target, getByTestId } = renderHost();
    fireEvent.contextMenu(target, { clientX: 123, clientY: 45 });
    const panel = getByTestId("context-menu-panel");
    expect(panel.style.left).toBe("123px");
    expect(panel.style.top).toBe("45px");
  });
});

describe("resolveHoldPointerPhase", () => {
  it("treats early movement as scroll, not drag or menu", () => {
    expect(
      resolveHoldPointerPhase({ elapsedMs: 80, moved: true }),
    ).toBe("scroll");
  });

  it("arms drag after the hold delay", () => {
    expect(
      resolveHoldPointerPhase({ elapsedMs: DRAG_ARM_MS, moved: false }),
    ).toBe("drag");
    expect(
      resolveHoldPointerPhase({ elapsedMs: DRAG_ARM_MS + 40, moved: true }),
    ).toBe("drag");
  });

  it("opens the menu only when the pointer stays still until the long-press", () => {
    expect(
      resolveHoldPointerPhase({
        elapsedMs: CONTEXT_MENU_LONG_PRESS_MS,
        moved: false,
      }),
    ).toBe("menu");
    expect(
      resolveHoldPointerPhase({
        elapsedMs: CONTEXT_MENU_LONG_PRESS_MS,
        moved: true,
      }),
    ).toBe("drag");
  });
});
