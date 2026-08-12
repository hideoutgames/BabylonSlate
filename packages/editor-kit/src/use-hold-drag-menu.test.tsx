import { render, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "./use-context-menu";
import { useHoldDragMenu } from "./use-hold-drag-menu";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function TestHost({
  enabled = true,
  onArm,
  onDragMove,
  onDrop,
  onMenu,
}: {
  enabled?: boolean;
  onArm?: () => void;
  onDragMove?: (x: number, y: number) => void;
  onDrop?: (x: number, y: number) => void;
  onMenu?: (x: number, y: number) => void;
}) {
  const { armed, dragging, bind } = useHoldDragMenu({
    enabled,
    onArm,
    onDragMove,
    onDrop,
    onMenu,
  });
  return (
    <div data-testid="target" {...bind}>
      <span data-testid="armed">{armed ? "yes" : "no"}</span>
      <span data-testid="dragging">{dragging ? "yes" : "no"}</span>
    </div>
  );
}

const ORIGIN = { clientX: 10, clientY: 20 };

function renderHost(
  handlers: {
    enabled?: boolean;
    onArm?: () => void;
    onDragMove?: (x: number, y: number) => void;
    onDrop?: (x: number, y: number) => void;
    onMenu?: (x: number, y: number) => void;
  } = {},
) {
  const utils = render(<TestHost {...handlers} />);
  return {
    ...utils,
    target: utils.getByTestId("target"),
    armed: () => utils.getByTestId("armed").textContent,
    dragging: () => utils.getByTestId("dragging").textContent,
  };
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useHoldDragMenu", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("treats movement before the arm delay as scroll, not drag or menu", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    const onMenu = vi.fn();
    const { target } = renderHost({ onDrop, onMenu });
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    dispatchPointerEvent(target, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
      clientY: ORIGIN.clientY,
    });
    await advance(CONTEXT_MENU_LONG_PRESS_MS);
    dispatchPointerEvent(target, "pointerup", {
      clientX: ORIGIN.clientX + 40,
      clientY: ORIGIN.clientY,
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("arms after a stationary hold, then drops on move and release", async () => {
    vi.useFakeTimers();
    const onArm = vi.fn();
    const onDragMove = vi.fn();
    const onDrop = vi.fn();
    const onMenu = vi.fn();
    const { target, armed, dragging } = renderHost({
      onArm,
      onDragMove,
      onDrop,
      onMenu,
    });
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advance(DRAG_ARM_MS);
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(armed()).toBe("yes");
    expect(dragging()).toBe("no");
    expect(onMenu).not.toHaveBeenCalled();

    await act(async () => {
      dispatchPointerEvent(target, "pointermove", {
        clientX: ORIGIN.clientX + 30,
        clientY: ORIGIN.clientY + 40,
      });
    });
    expect(onDragMove).toHaveBeenCalledWith(ORIGIN.clientX + 30, ORIGIN.clientY + 40);
    expect(dragging()).toBe("yes");

    dispatchPointerEvent(target, "pointerup", {
      clientX: ORIGIN.clientX + 30,
      clientY: ORIGIN.clientY + 40,
    });
    expect(onDrop).toHaveBeenCalledWith(ORIGIN.clientX + 30, ORIGIN.clientY + 40);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("does not open the menu while the pointer is still down at the long-press delay", async () => {
    vi.useFakeTimers();
    const onMenu = vi.fn();
    const { target } = renderHost({ onMenu });
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advance(CONTEXT_MENU_LONG_PRESS_MS);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("opens the menu on release after a stationary long press", async () => {
    vi.useFakeTimers();
    const onMenu = vi.fn();
    const onDrop = vi.fn();
    const { target } = renderHost({ onMenu, onDrop });
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advance(CONTEXT_MENU_LONG_PRESS_MS);
    dispatchPointerEvent(target, "pointerup", ORIGIN);
    expect(onMenu).toHaveBeenCalledWith(ORIGIN.clientX, ORIGIN.clientY);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("does not open the menu on a short tap", async () => {
    vi.useFakeTimers();
    const onMenu = vi.fn();
    const { target } = renderHost({ onMenu });
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    await advance(DRAG_ARM_MS - 50);
    dispatchPointerEvent(target, "pointerup", ORIGIN);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("ignores mouse pointers so HTML5 drag and contextmenu own them", async () => {
    vi.useFakeTimers();
    const onArm = vi.fn();
    const onMenu = vi.fn();
    const { target } = renderHost({ onArm, onMenu });
    dispatchPointerEvent(target, "pointerdown", {
      ...ORIGIN,
      pointerType: "mouse",
    });
    await advance(CONTEXT_MENU_LONG_PRESS_MS);
    dispatchPointerEvent(target, "pointerup", {
      ...ORIGIN,
      pointerType: "mouse",
    });
    expect(onArm).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("captures the pointer so the gesture survives leaving the element", () => {
    const { target } = renderHost();
    const capture = vi.fn();
    (target as HTMLElement).setPointerCapture = capture;
    dispatchPointerEvent(target, "pointerdown", ORIGIN);
    expect(capture).toHaveBeenCalledWith(1);
  });
});
