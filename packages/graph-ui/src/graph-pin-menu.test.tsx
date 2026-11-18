import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument, PaletteNode, SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
});

const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const execOut: SerializedPin = { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } };

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

/** A `contextmenu` from a touch hold: jsdom has no PointerEvent, so the field is defined on a MouseEvent. */
function touchContextMenu(target: Element): void {
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

  it("keeps the node menu for a right-click on the pin's label and for a touch hold on the pin", () => {
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} />);
    fireEvent.contextMenu(nodeEl(container, "log-a").querySelector('[data-pin-label="then"]')!);
    expect(menuEntries()).toContain("copy");
    fireEvent.click(screen.getByTestId("context-menu-backdrop"));
    touchContextMenu(pin(container, "log-a", "execOut"));
    expect(menuEntries()).toContain("copy");
    expect(item("break-pin-links")).toBeNull();
  });
});
