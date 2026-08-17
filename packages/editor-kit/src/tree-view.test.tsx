import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  TREE_ROW_HEIGHT,
  TREE_SWIPE_ADD_PX,
  TreeView,
  rangeSelectTreeIds,
  type TreeViewNode,
} from "./tree-view";
import { dispatchPointerEvent } from "./test-support/pointer-events";
import { CONTEXT_MENU_LONG_PRESS_MS, DRAG_ARM_MS } from "./use-context-menu";

const nodes: TreeViewNode[] = [
  { id: "root", label: "Root", depth: 0, hasChildren: true, expanded: true },
  { id: "child", label: "Child", depth: 1, hasChildren: false, expanded: false },
  { id: "other", label: "Other", depth: 0, hasChildren: false, expanded: false },
];

describe("TreeView", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses compact chrome-row height", () => {
    expect(TREE_ROW_HEIGHT).toBe(28);
  });

  it("renders one row per visible node with disclosure state", () => {
    render(<TreeView nodes={nodes} data-testid="tree" />);
    expect(
      screen.getByTestId("tree-row-root").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByTestId("tree-row-child").getAttribute("aria-expanded"),
    ).toBeNull();
    expect(
      screen.getByTestId("tree-row-child").getAttribute("data-depth"),
    ).toBe("1");
  });

  it("selects a row on tap", () => {
    const onSelect = vi.fn();
    render(<TreeView nodes={nodes} onSelect={onSelect} data-testid="tree" />);
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("child");
    expect(onSelect.mock.calls[0]).toHaveLength(1);
  });

  it("adds a row on Ctrl Shift or Meta click", () => {
    const onSelect = vi.fn();
    render(<TreeView nodes={nodes} onSelect={onSelect} data-testid="tree" />);
    const row = screen.getByTestId("tree-row-other");
    dispatchPointerEvent(row, "pointerdown", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
      ctrlKey: true,
    });
    dispatchPointerEvent(row, "pointerup", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
      ctrlKey: true,
    });
    expect(onSelect).toHaveBeenCalledWith("other", { additive: true });
  });

  it("adds a row on a horizontal swipe of at least 44px", () => {
    const onSelect = vi.fn();
    const onReparent = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onSelect={onSelect}
        onReparent={onReparent}
        reparentArm="immediate"
        data-testid="tree"
      />,
    );
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 50 });
    dispatchPointerEvent(row, "pointermove", {
      clientX: 10 + TREE_SWIPE_ADD_PX,
      clientY: 50,
    });
    dispatchPointerEvent(row, "pointerup", {
      clientX: 10 + TREE_SWIPE_ADD_PX,
      clientY: 50,
    });
    expect(onSelect).toHaveBeenCalledWith("child", { additive: true });
    expect(onReparent).not.toHaveBeenCalled();
  });

  it("range-selects from the current row to a two-finger tap", () => {
    const onSelect = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        selectedId="root"
        onSelect={onSelect}
        data-testid="tree"
      />,
    );
    const first = screen.getByTestId("tree-row-root");
    const second = screen.getByTestId("tree-row-other");
    dispatchPointerEvent(first, "pointerdown", {
      pointerId: 1,
      clientX: 12,
      clientY: 10,
    });
    dispatchPointerEvent(second, "pointerdown", {
      pointerId: 2,
      clientX: 12,
      clientY: 60,
    });
    dispatchPointerEvent(second, "pointerup", {
      pointerId: 2,
      clientX: 12,
      clientY: 60,
    });
    dispatchPointerEvent(first, "pointerup", {
      pointerId: 1,
      clientX: 12,
      clientY: 10,
    });
    expect(onSelect).toHaveBeenCalledWith("other", { range: true });
  });

  it("highlights every id in selectedIds", () => {
    render(
      <TreeView
        nodes={nodes}
        selectedIds={["root", "other"]}
        data-testid="tree"
      />,
    );
    expect(screen.getByTestId("tree-row-root").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId("tree-row-child").getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByTestId("tree-row-other").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("slices inclusive range ids between two visible rows", () => {
    expect(rangeSelectTreeIds(["root", "child", "other"], "root", "other")).toEqual(
      ["root", "child", "other"],
    );
    expect(rangeSelectTreeIds(["root", "child", "other"], "other", "child")).toEqual(
      ["child", "other"],
    );
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
    expect(screen.queryByTestId("tree-disclosure-child")).toBeNull();
  });

  it("reparents when a row is held then dragged onto another row", () => {
    vi.useFakeTimers();
    const onReparent = vi.fn();
    render(<TreeView nodes={nodes} onReparent={onReparent} data-testid="tree" />);

    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 96 }) as DOMRect;

    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    dispatchPointerEvent(row, "pointermove", { clientX: 10, clientY: 80 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 80 });

    expect(onReparent).toHaveBeenCalledWith("child", "other");
    vi.useRealTimers();
  });

  it("reparents immediately when reparentArm is immediate", () => {
    const onReparent = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onReparent={onReparent}
        reparentArm="immediate"
        data-testid="tree"
      />,
    );

    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 84 }) as DOMRect;

    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 40 });
    dispatchPointerEvent(row, "pointermove", { clientX: 10, clientY: 70 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 70 });

    expect(onReparent).toHaveBeenCalledWith("child", "other");
  });

  it("does not reparent when the pointer moves before the hold arms", () => {
    const onReparent = vi.fn();
    render(<TreeView nodes={nodes} onReparent={onReparent} data-testid="tree" />);

    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 96 }) as DOMRect;

    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 40 });
    dispatchPointerEvent(row, "pointermove", { clientX: 10, clientY: 80 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 80 });

    expect(onReparent).not.toHaveBeenCalled();
  });

  it("does not capture the pointer on down when reparent uses hold so the list can scroll", () => {
    const capture = vi.fn();
    render(
      <TreeView nodes={nodes} onReparent={() => {}} data-testid="tree" />,
    );
    const tree = screen.getByTestId("tree");
    tree.setPointerCapture = capture;
    dispatchPointerEvent(screen.getByTestId("tree-row-child"), "pointerdown", {
      clientX: 10,
      clientY: 40,
      pointerId: 7,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures the pointer after the reparent hold arms", () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    render(
      <TreeView nodes={nodes} onReparent={() => {}} data-testid="tree" />,
    );
    const tree = screen.getByTestId("tree");
    tree.setPointerCapture = capture;
    dispatchPointerEvent(screen.getByTestId("tree-row-child"), "pointerdown", {
      clientX: 10,
      clientY: 40,
      pointerId: 7,
    });
    expect(capture).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    expect(capture).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it("lets rows pan vertically instead of taking touch-action none", () => {
    render(<TreeView nodes={nodes} data-testid="tree" />);
    expect(screen.getByTestId("tree-row-child").className).not.toContain(
      "touch-none",
    );
  });

  it("does not select a row on a short drag that is not a swipe-add", () => {
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
    dispatchPointerEvent(row, "pointermove", { clientX: 20, clientY: 50 });
    dispatchPointerEvent(row, "pointerup", { clientX: 20, clientY: 50 });
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

  it("activates a row on double tap", () => {
    const onActivate = vi.fn();
    render(
      <TreeView nodes={nodes} onActivate={onActivate} data-testid="tree" />,
    );
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    expect(onActivate).toHaveBeenCalledWith("child");
  });

  it("renders an empty label with no nodes", () => {
    render(<TreeView nodes={[]} emptyLabel="No actors" data-testid="tree" />);
    expect(screen.getByText("No actors")).toBeTruthy();
  });

  it("marks the selected row with a primary edge", () => {
    render(<TreeView nodes={nodes} selectedId="child" data-testid="tree" />);
    expect(screen.getByTestId("tree-row-child").className).toContain(
      "border-l-primary",
    );
  });

  it("renders an optional leading icon", () => {
    render(
      <TreeView
        nodes={[
          {
            ...nodes[2]!,
            icon: <span data-testid="row-icon">icon</span>,
          },
        ]}
        data-testid="tree"
      />,
    );
    expect(screen.getByTestId("row-icon")).toBeTruthy();
  });

  it("does not start a reparent from trailing controls", () => {
    const onReparent = vi.fn();
    const onSelect = vi.fn();
    render(
      <TreeView
        nodes={[
          {
            ...nodes[2]!,
            trailing: <button type="button" data-testid="row-menu">…</button>,
          },
        ]}
        onReparent={onReparent}
        onSelect={onSelect}
        reparentArm="immediate"
        data-testid="tree"
      />,
    );
    const menu = screen.getByTestId("row-menu");
    dispatchPointerEvent(menu, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(menu, "pointermove", { clientX: 10, clientY: 40 });
    dispatchPointerEvent(menu, "pointerup", { clientX: 10, clientY: 40 });
    expect(onReparent).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("drops a row onto a client point with mouse after 8px without reparent", () => {
    const onExternalDrop = vi.fn();
    const onSelect = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onExternalDrop={onExternalDrop}
        onSelect={onSelect}
        data-testid="tree"
      />,
    );
    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 84, width: 200, height: 84 }) as DOMRect;
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 40,
    });
    dispatchPointerEvent(row, "pointermove", {
      pointerType: "mouse",
      clientX: 260,
      clientY: 180,
    });
    dispatchPointerEvent(row, "pointerup", {
      pointerType: "mouse",
      clientX: 260,
      clientY: 180,
    });
    expect(onExternalDrop).toHaveBeenCalledWith("child", 260, 180);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still external-drops after a horizontal move that would swipe-add", () => {
    const onExternalDrop = vi.fn();
    const onSelect = vi.fn();
    render(
      <TreeView
        nodes={nodes}
        onExternalDrop={onExternalDrop}
        onSelect={onSelect}
        data-testid="tree"
      />,
    );
    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 84, width: 200, height: 84 }) as DOMRect;
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 40,
    });
    dispatchPointerEvent(row, "pointermove", {
      pointerType: "mouse",
      clientX: 10 + TREE_SWIPE_ADD_PX,
      clientY: 40,
    });
    dispatchPointerEvent(row, "pointermove", {
      pointerType: "mouse",
      clientX: 260,
      clientY: 180,
    });
    dispatchPointerEvent(row, "pointerup", {
      pointerType: "mouse",
      clientX: 260,
      clientY: 180,
    });
    expect(onExternalDrop).toHaveBeenCalledWith("child", 260, 180);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not external-drop a touch drag until the hold arms", () => {
    vi.useFakeTimers();
    const onExternalDrop = vi.fn();
    render(
      <TreeView nodes={nodes} onExternalDrop={onExternalDrop} data-testid="tree" />,
    );
    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 84, width: 200, height: 84 }) as DOMRect;
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 40 });
    dispatchPointerEvent(row, "pointermove", { clientX: 260, clientY: 180 });
    dispatchPointerEvent(row, "pointerup", { clientX: 260, clientY: 180 });
    expect(onExternalDrop).not.toHaveBeenCalled();

    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    dispatchPointerEvent(row, "pointermove", { clientX: 260, clientY: 180 });
    dispatchPointerEvent(row, "pointerup", { clientX: 260, clientY: 180 });
    expect(onExternalDrop).toHaveBeenCalledWith("child", 260, 180);
    vi.useRealTimers();
  });

  it("does not external-drop when the pointer is released inside the tree", () => {
    const onExternalDrop = vi.fn();
    render(
      <TreeView nodes={nodes} onExternalDrop={onExternalDrop} data-testid="tree" />,
    );
    const tree = screen.getByTestId("tree");
    tree.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: 84, width: 200, height: 84 }) as DOMRect;
    const row = screen.getByTestId("tree-row-child");
    dispatchPointerEvent(row, "pointerdown", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 40,
    });
    dispatchPointerEvent(row, "pointermove", {
      pointerType: "mouse",
      clientX: 20,
      clientY: 70,
    });
    dispatchPointerEvent(row, "pointerup", {
      pointerType: "mouse",
      clientX: 20,
      clientY: 70,
    });
    expect(onExternalDrop).not.toHaveBeenCalled();
  });
});
