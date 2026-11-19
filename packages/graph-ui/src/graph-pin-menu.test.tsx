import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument, PaletteNode, SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const execOut: SerializedPin = { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } };
const valueIn: SerializedPin = { id: "value", name: "value", kind: "data", direction: "in", type: { kind: "float" } };

function logNode(id: string, x: number) {
  return { id, type: "debug.log", position: { x, y: 0 }, data: { __pins: [execIn, execOut] } };
}

/** log-a fans out to log-b and log-c; log-d is unwired. */
function wiredGraph(): GraphDocument {
  return {
    nodes: [logNode("log-a", 0), logNode("log-b", 280), logNode("log-c", 560), logNode("log-d", 840)],
    edges: [
      { id: "a-b", source: "log-a", target: "log-b", sourceHandle: "execOut", targetHandle: "execIn" },
      { id: "a-c", source: "log-a", target: "log-c", sourceHandle: "execOut", targetHandle: "execIn" },
      { id: "b-c", source: "log-b", target: "log-c", sourceHandle: "execOut", targetHandle: "execIn" },
    ],
  };
}

const palette: PaletteNode[] = [{ id: "debug.log", title: "Log", category: "Debug" }];

function pin(container: HTMLElement, nodeId: string, pinId: string): HTMLElement {
  return container.querySelector(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${pinId}"]`)!;
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
}

function selectedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id")!);
}

function menuEntries(): string[] {
  const panel = screen.queryByTestId("context-menu-panel");
  if (!panel) return [];
  return [...panel.querySelectorAll('[data-testid^="context-menu-item-"]')]
    .map((entry) => entry.getAttribute("data-testid")!.replace("context-menu-item-", ""));
}

const item = (id: string) => screen.queryByTestId(`context-menu-item-${id}`) as HTMLButtonElement | null;
const lastGraph = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as GraphDocument;

const OPEN = "data-pin-menu-open";

/** The row half (glyph, inline default and name) of a pin. */
function cell(container: HTMLElement, nodeId: string, pinId: string): HTMLElement {
  return pin(container, nodeId, pinId).closest<HTMLElement>("[data-pin-cell]")!;
}

function heldCells(container: HTMLElement): Element[] {
  return [...container.querySelectorAll(`[${OPEN}]`)];
}

/** A touch press: jsdom has no PointerEvent, so the pointer fields are defined on a MouseEvent. */
function touchPress(target: Element): void {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  Object.defineProperty(event, "pointerId", { value: 7 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "isPrimary", { value: true });
  target.dispatchEvent(event);
}

/** The `contextmenu` Android sends at the end of a touch hold. */
function androidContextMenu(target: Element): void {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe("pin context menu", () => {
  it("lists Break Links before the host's items and asks the host once per open with the pin's ids", () => {
    const itemsForPin = vi.fn((nodeId: string, pinId: string) => [
      { id: "convert-pin", label: "Convert Pin", onSelect: () => [nodeId, pinId] },
    ]);
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} contextMenuItemsForPin={itemsForPin} />);
    fireEvent.contextMenu(pin(container, "log-b", "execOut"));
    expect(menuEntries()).toEqual(["break-pin-links", "convert-pin"]);
    expect(item("break-pin-links")!.textContent).toBe("Break Links");
    expect(itemsForPin.mock.calls).toEqual([["log-b", "execOut"]]);
  });

  it("removes exactly the pin's wires as one change", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    fireEvent.contextMenu(pin(container, "log-c", "execIn"));
    fireEvent.click(item("break-pin-links")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastGraph(onChange).edges.map((edge) => edge.id)).toEqual(["a-b"]);
    expect(lastGraph(onChange).nodes).toHaveLength(4);
  });

  it("removes the links the host's break rule names for the pin", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GraphEditor
        initialGraph={wiredGraph()}
        onChange={onChange}
        // Breaking at a pin removes every wire of its node.
        edgeBreaksAtPin={(edge, nodeId) => edge.source === nodeId || edge.target === nodeId}
      />,
    );
    fireEvent.contextMenu(pin(container, "log-b", "execIn"));
    fireEvent.click(item("break-pin-links")!);
    expect(lastGraph(onChange).edges.map((edge) => edge.id)).toEqual(["a-c"]);
  });

  it("opens the node menu instead for an unwired pin with no host items", () => {
    const itemsForPin = vi.fn(() => []);
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} contextMenuItemsForPin={itemsForPin} />);
    fireEvent.contextMenu(pin(container, "log-d", "execIn"));
    expect(menuEntries()).toContain("copy");
    expect(item("break-pin-links")).toBeNull();
    expect(itemsForPin).toHaveBeenCalledTimes(1);
  });

  it("opens with the host's items alone on an unwired pin", () => {
    const { container } = render(
      <GraphEditor
        initialGraph={wiredGraph()}
        contextMenuItemsForPin={() => [{ id: "add-pin", label: "Add Pin", onSelect: () => undefined }]}
      />,
    );
    fireEvent.contextMenu(pin(container, "log-d", "execOut"));
    expect(menuEntries()).toEqual(["add-pin"]);
  });

  it("offers no Break Links on a read-only canvas but keeps the host's items", () => {
    const { container, rerender } = render(<GraphEditor initialGraph={wiredGraph()} readOnly />);
    fireEvent.contextMenu(pin(container, "log-a", "execOut"));
    expect(item("break-pin-links")).toBeNull();
    rerender(
      <GraphEditor
        initialGraph={wiredGraph()}
        readOnly
        contextMenuItemsForPin={() => [{ id: "inspect-pin", label: "Inspect Pin", onSelect: () => undefined }]}
      />,
    );
    fireEvent.contextMenu(pin(container, "log-a", "execOut"));
    expect(menuEntries()).toEqual(["inspect-pin"]);
  });

  it("leaves Break Links out when the host hides it from the toolbar", () => {
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} hiddenToolbarActions={["breakLinks"]} />);
    fireEvent.contextMenu(pin(container, "log-a", "execOut"));
    expect(item("break-pin-links")).toBeNull();
  });

  it("neither selects, starts a wire nor opens the pane menu", () => {
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} paletteNodes={palette} />);
    fireEvent.click(nodeEl(container, "log-d"));
    const handle = pin(container, "log-a", "execOut");
    fireEvent.pointerDown(handle, { button: 2, buttons: 2 });
    fireEvent.mouseDown(handle, { button: 2, buttons: 2 });
    const opened = !fireEvent.contextMenu(handle);
    expect(opened).toBe(true);
    expect(menuEntries()).toEqual(["break-pin-links"]);
    expect(selectedIds(container)).toEqual(["log-d"]);
    expect(container.querySelector(".react-flow__connectionline")).toBeNull();
    expect(screen.queryByTestId("node-palette")).toBeNull();
  });

  it("opens from the pin's name, and keeps the node menu for its inline default", () => {
    const graph = wiredGraph();
    graph.nodes.push({ id: "log-e", type: "debug.log", position: { x: 1120, y: 0 }, data: { __pins: [valueIn] } });
    const { container } = render(
      <GraphEditor
        initialGraph={graph}
        contextMenuItemsForPin={(_, pinId) => [{ id: `about-${pinId}`, label: "About Pin", onSelect: () => undefined }]}
      />,
    );
    fireEvent.contextMenu(nodeEl(container, "log-a").querySelector('[data-pin-label="then"]')!);
    expect(menuEntries()).toEqual(["break-pin-links", "about-execOut"]);
    expect(selectedIds(container)).toEqual([]);
    fireEvent.click(screen.getByTestId("context-menu-backdrop"));
    const defaultEditor = nodeEl(container, "log-e").querySelector(".graph-pin-default-editor");
    expect(defaultEditor).not.toBeNull();
    fireEvent.contextMenu(defaultEditor!);
    expect(item("about-value")).toBeNull();
    expect(menuEntries()).toContain("copy");
  });

  it("marks the pin's cell while its menu is open and clears it on every way it closes", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    const open = (nodeId: string, pinId: string) => {
      fireEvent.contextMenu(pin(container, nodeId, pinId));
      expect(heldCells(container)).toEqual([cell(container, nodeId, pinId)]);
    };
    // Only the pin's own half of its row.
    open("log-b", "execOut");
    expect(cell(container, "log-b", "execIn").hasAttribute(OPEN)).toBe(false);
    fireEvent.click(item("break-pin-links")!);
    expect(heldCells(container)).toEqual([]);

    open("log-a", "execOut");
    fireEvent.keyDown(screen.getByTestId("context-menu-panel"), { key: "Escape" });
    expect(screen.queryByTestId("context-menu-panel")).toBeNull();
    expect(heldCells(container)).toEqual([]);

    open("log-a", "execOut");
    fireEvent.pointerDown(screen.getByTestId("context-menu-backdrop"));
    expect(heldCells(container)).toEqual([]);

    open("log-a", "execOut");
    fireEvent.scroll(document);
    expect(heldCells(container)).toEqual([]);

    // The node goes away (undo, virtualisation) with the menu still open.
    open("log-a", "execOut");
    const held = cell(container, "log-a", "execOut");
    rerender(<GraphEditor initialGraph={{ nodes: wiredGraph().nodes.slice(1), edges: [] }} onChange={onChange} />);
    expect(nodeEl(container, "log-a")).toBeNull();
    expect(held.hasAttribute(OPEN)).toBe(false);
  });

  it("marks nothing when the node menu opens", () => {
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} />);
    fireEvent.contextMenu(pin(container, "log-d", "execIn"));
    expect(menuEntries()).toContain("copy");
    expect(heldCells(container)).toEqual([]);
  });

  it("opens the pin menu once for a touch hold, even when Android follows it with contextmenu", () => {
    vi.useFakeTimers();
    const itemsForPin = vi.fn(() => [{ id: "about-pin", label: "About Pin", onSelect: () => undefined }]);
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} contextMenuItemsForPin={itemsForPin} />);
    const handle = pin(container, "log-a", "execOut");
    touchPress(handle);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(menuEntries()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(menuEntries()).toEqual(["break-pin-links", "about-pin"]);
    expect(heldCells(container)).toEqual([cell(container, "log-a", "execOut")]);
    androidContextMenu(handle);
    expect(itemsForPin).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("context-menu-panel")).toHaveLength(1);
    expect(selectedIds(container)).toEqual([]);
  });

  it("opens the pin menu from Android's contextmenu alone, and the node menu for a pin with nothing to offer", () => {
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} />);
    androidContextMenu(pin(container, "log-a", "execOut"));
    expect(menuEntries()).toEqual(["break-pin-links"]);
    fireEvent.click(screen.getByTestId("context-menu-backdrop"));
    vi.useFakeTimers();
    touchPress(pin(container, "log-d", "execIn"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(menuEntries()).toContain("copy");
    expect(selectedIds(container)).toEqual(["log-d"]);
  });
});
