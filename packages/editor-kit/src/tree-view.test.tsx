import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TreeView, type TreeViewNode } from "./tree-view";
import { dispatchPointerEvent } from "./test-support/pointer-events";
import { CONTEXT_MENU_LONG_PRESS_MS } from "./use-context-menu";

const nodes: TreeViewNode[] = [
  { id: "root", label: "Root", depth: 0, hasChildren: true, expanded: true },
  { id: "child", label: "Child", depth: 1, hasChildren: false, expanded: false },
  { id: "other", label: "Other", depth: 0, hasChildren: false, expanded: false },
];

describe("TreeView", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one row per visible node with disclosure state", () => {
    render(<TreeView nodes={nodes} data-testid="tree" />);
    expect(
      screen.getByTestId("tree-row-root").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByTestId("tree-row-child").getAttribute("aria-expanded"),
    ).toBeNull();
  });

  it("selects a row on tap", () => {
    const onSelect = vi.fn();
    render(<TreeView nodes={nodes} onSelect={onSelect} data-testid="tree" />);
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("child");
  });

  it("toggles expansion from the disclosure control", () => {
    const onToggleExpanded = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onToggleExpanded={onToggleExpanded}
        data-testid="tree"
      />,
    );
    screen.getByTestId("tree-disclosure-root").click();
    expect(onToggleExpanded).toHaveBeenCalledWith("root");
  });

  it("reparents when a row is dragged onto another row", () => {
    const onReparent = vi.fn();
    render(<TreeView nodes={nodes} onReparent={onReparent} data-testid="tree" />);

    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 132 }) as DOMRect;

    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 50 });
    dispatchPointerEvent(row, "pointermove", { clientX: 10, clientY: 100 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 100 });

    expect(onReparent).toHaveBeenCalledWith("child", "other");
  });

  it("does not select a row when the pointer dragged", () => {
    const onSelect = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onSelect={onSelect}
        onReparent={() => {}}
        data-testid="tree"
      />,
    );
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 50 });
    dispatchPointerEvent(row, "pointermove", { clientX: 90, clientY: 50 });
    dispatchPointerEvent(row, "pointerup", { clientX: 90, clientY: 50 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the context menu on a stationary long press", () => {
    vi.useFakeTimers();
    const onContextMenu = vi.fn();
    render(
      <TreeView nodes={nodes} onContextMenu={onContextMenu} data-testid="tree" />,
    );
    const row = screen.getByTestId("tree-row-root");
    dispatchPointerEvent(row, "pointerdown", { clientX: 12, clientY: 20 });
    act(() => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onContextMenu).toHaveBeenCalledWith("root", 12, 20);
    vi.useRealTimers();
  });

  it("renders an empty label with no nodes", () => {
    render(<TreeView nodes={[]} emptyLabel="No actors" data-testid="tree" />);
    expect(screen.getByText("No actors")).toBeTruthy();
  });
});
