import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import { treeNodeTypes } from "./tree-node";
import type { GraphBreakpoints } from "./graph-breakpoints";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(cleanup);

const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const execOut: SerializedPin = { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } };
const valueOut: SerializedPin = { id: "out", name: "Value", kind: "data", direction: "out", type: { kind: "float" } };

/** Two calls in an exec chain and a pure node, which no execution reaches. */
const graph: GraphDocument = {
  nodes: [
    { id: "print", type: "debug.log", position: { x: 0, y: 0 }, data: { __pins: [execIn, execOut] } },
    { id: "pure", type: "math.add", position: { x: 400, y: 0 }, data: { __pins: [valueOut] } },
    { id: "call", type: "debug.log", position: { x: 0, y: 300 }, data: { __pins: [execIn, execOut] } },
  ],
  edges: [
    { id: "wire", source: "print", sourceHandle: "execOut", target: "call", targetHandle: "execIn" },
  ],
};

function hostBreakpoints(): { view: GraphBreakpoints; set: Map<string, "enabled" | "disabled">; edit: ReturnType<typeof vi.fn> } {
  const set = new Map<string, "enabled" | "disabled">();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const edit = vi.fn();
  const view: GraphBreakpoints = {
    state: (nodeId) => set.get(nodeId) ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    toggle: (nodeId) => {
      if (!set.delete(nodeId)) set.set(nodeId, "enabled");
      publish();
    },
    setEnabled: (nodeId, enabled) => {
      if (!set.has(nodeId)) return;
      set.set(nodeId, enabled ? "enabled" : "disabled");
      publish();
    },
    edit,
  };
  return { view, set, edit };
}

const nodeEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const dot = (container: HTMLElement, id: string) =>
  nodeEl(container, id).querySelector<HTMLElement>("[data-breakpoint], button[aria-label$='Breakpoint']");

function pressF9() {
  fireEvent.keyDown(document.body, { key: "F9", code: "F9" });
  fireEvent.keyUp(document.body, { key: "F9", code: "F9" });
}

describe("graph breakpoints", () => {
  it("toggle with the key on the selected nodes that execution reaches, on a read-only canvas too", () => {
    const { view, set } = hostBreakpoints();
    const { container } = render(<GraphEditor initialGraph={graph} readOnly breakpoints={view} />);
    fireEvent.pointerDown(screen.getByTestId("graph-editor"));
    fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
    fireEvent.click(nodeEl(container, "print"));
    fireEvent.click(nodeEl(container, "pure"));
    fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });

    act(pressF9);
    expect([...set.keys()]).toEqual(["print"]);
    expect(dot(container, "print")?.dataset.breakpoint).toBe("enabled");
    expect(dot(container, "pure")).toBeNull();

    act(pressF9);
    expect(set.size).toBe(0);
    expect(dot(container, "print")?.dataset.breakpoint).toBeUndefined();
  });

  it("toggle on card nodes when the host lets every node have one", () => {
    const { view, set } = hostBreakpoints();
    const tree: GraphDocument = {
      nodes: [{ id: "wait", type: "bt.node", position: { x: 0, y: 0 }, data: { title: "Wait", kind: "task" } }],
      edges: [],
    };
    const { container } = render(
      <GraphEditor initialGraph={tree} nodeTypes={treeNodeTypes} breakpoints={{ ...view, canBreak: () => true }} />,
    );
    fireEvent.pointerDown(screen.getByTestId("graph-editor"));
    fireEvent.click(nodeEl(container, "wait"));
    act(pressF9);
    expect([...set.keys()]).toEqual(["wait"]);
    expect(dot(container, "wait")?.dataset.breakpoint).toBe("enabled");
  });

  it("toggle from the node's title-bar dot", () => {
    const { view, set } = hostBreakpoints();
    const { container } = render(<GraphEditor initialGraph={graph} breakpoints={view} />);
    act(() => { fireEvent.click(dot(container, "print")!); });
    expect([...set.keys()]).toEqual(["print"]);
    expect(dot(container, "print")?.getAttribute("aria-label")).toBe("Remove Breakpoint");
  });

  /** Selects nodes with Control held, as a multi-selection click does. */
  function selectNodes(container: HTMLElement, ids: readonly string[]) {
    fireEvent.pointerDown(screen.getByTestId("graph-editor"));
    fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
    for (const id of ids) fireEvent.click(nodeEl(container, id));
    fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });
  }
  const press = (key: string, init: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) =>
    act(() => {
      fireEvent.keyDown(document.body, { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...init });
    });
  const menuItem = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
  const openMenu = (container: HTMLElement, id: string) =>
    act(() => { fireEvent.contextMenu(nodeEl(container, id).querySelector("[data-node-role]")!); });

  it("set from a node menu act on every selected node that can have one, and show their keys", () => {
    const { view, set, edit } = hostBreakpoints();
    const { container } = render(<GraphEditor initialGraph={graph} breakpoints={view} />);
    // One of the two calls already has one: Add adds the other and keeps it, rather than flipping each.
    act(() => view.toggle("call"));
    selectNodes(container, ["print", "call", "pure"]);
    openMenu(container, "print");
    expect(menuItem("Add Breakpoint").getAttribute("aria-keyshortcuts")).toBe("F9");
    act(() => { fireEvent.click(menuItem("Add Breakpoint")); });
    expect(Object.fromEntries(set)).toEqual({ call: "enabled", print: "enabled" });

    openMenu(container, "call");
    expect(screen.queryByRole("menuitem", { name: /^Add Breakpoint/ })).toBeNull();
    expect(menuItem("Disable Breakpoint").getAttribute("aria-keyshortcuts")).toBe("Control+F9");
    act(() => { fireEvent.click(menuItem("Disable Breakpoint")); });
    expect(Object.fromEntries(set)).toEqual({ call: "disabled", print: "disabled" });

    // Edit Breakpoint… edits the node the menu opened on.
    openMenu(container, "call");
    expect(menuItem("Enable Breakpoint")).toBeTruthy();
    expect(menuItem("Edit Breakpoint…").getAttribute("aria-keyshortcuts")).toBe("Shift+F9");
    act(() => { fireEvent.click(menuItem("Edit Breakpoint…")); });
    expect(edit).toHaveBeenCalledWith("call");

    openMenu(container, "print");
    act(() => { fireEvent.click(menuItem("Remove Breakpoint")); });
    expect(set.size).toBe(0);
  });

  it("enable, disable and edit with keys on the selection, on a read-only canvas too", () => {
    const { view, set, edit } = hostBreakpoints();
    const { container } = render(<GraphEditor initialGraph={graph} readOnly breakpoints={view} />);
    act(() => { view.toggle("print"); view.toggle("call"); view.setEnabled("call", false); });
    selectNodes(container, ["print", "call"]);

    // Any one on turns them all off; then all on.
    press("F9", { ctrlKey: true });
    expect(Object.fromEntries(set)).toEqual({ print: "disabled", call: "disabled" });
    press("F9", { ctrlKey: true });
    expect(Object.fromEntries(set)).toEqual({ print: "enabled", call: "enabled" });

    // The settings dialog edits one breakpoint, so Edit needs exactly one in the selection.
    press("F9", { shiftKey: true });
    expect(edit).not.toHaveBeenCalled();
    act(() => view.toggle("call"));
    press("F9", { shiftKey: true });
    expect(edit).toHaveBeenCalledWith("print");
  });

  it("break the selected node's links with the key the menu shows", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={graph} onChange={onChange} />);
    selectNodes(container, ["call"]);
    openMenu(container, "call");
    expect(menuItem("Break Links").getAttribute("aria-keyshortcuts")).toBe("Alt+L");
    act(() => { fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" }); });
    press("l", { altKey: true });
    expect(onChange.mock.calls.at(-1)?.[0].edges).toEqual([]);
  });
});
