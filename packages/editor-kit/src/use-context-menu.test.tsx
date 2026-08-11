import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { useRef } from "react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  useContextMenu,
  type ContextMenuItem,
} from "./use-context-menu";

function TestHost({
  items,
  enabled = true,
}: {
  items: ContextMenuItem[];
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { menu, bind } = useContextMenu(ref, { items, enabled });
  return (
    <div ref={ref} data-testid="target" {...bind}>
      {menu?.open ? "open" : "closed"}
    </div>
  );
}

describe("useContextMenu", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens on contextmenu event", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <TestHost
        items={[{ id: "a", label: "Action", onSelect }]}
      />,
    );
    const target = getByTestId("target");
    fireEvent.contextMenu(target, { clientX: 10, clientY: 20 });
    expect(target.textContent).toBe("open");
  });

  it("opens after long press on touch pointer", async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <TestHost items={[{ id: "a", label: "Action", onSelect }]} />,
    );
    const target = getByTestId("target");
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 5,
      clientY: 5,
    });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(target.textContent).toBe("open");
  });

  it("cancels long press when pointer moves", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(
      <TestHost items={[{ id: "a", label: "Action", onSelect: vi.fn() }]} />,
    );
    const target = getByTestId("target");
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 5,
      clientY: 5,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 40,
      clientY: 5,
    });
    vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    expect(target.textContent).toBe("closed");
    vi.useRealTimers();
  });
});
