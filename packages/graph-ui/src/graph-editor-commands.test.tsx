import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor, type GraphPasteElements, type GraphPasteResult } from "./graph-editor";
import { useGraphEditorContext, type GraphEditorContextValue } from "./graph-editor-context";
import { DEFAULT_GRAPH_KEYBINDS, GraphKeybindsContext } from "./graph-keybinds";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * jsdom has no PointerEvent: a MouseEvent with the pointer fields defined, as
 * the editor-kit test helper builds it (this package's rootDir cannot import it).
 */
function dispatchTouchDown(target: Element, clientX: number, clientY: number): void {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "isPrimary", { value: true });
  target.dispatchEvent(event);
}

const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const execOut: SerializedPin = { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } };
const logPins = [execIn, execOut];

function logNode(id: string, x: number, data: Record<string, unknown> = {}) {
  return { id, type: "debug.log", position: { x, y: 0 }, data: { __pins: logPins, ...data } };
}

/** log-a -> log-b and log-a -> log-c, plus an unwired log-d. */
function wiredGraph(): GraphDocument {
  return {
    nodes: [logNode("log-a", 0), logNode("log-b", 280), logNode("log-c", 560), logNode("log-d", 840)],
    edges: [
      { id: "e:log-a:execOut:log-b:execIn", source: "log-a", target: "log-b", sourceHandle: "execOut", targetHandle: "execIn" },
      { id: "e:log-a:execOut:log-c:execIn", source: "log-a", target: "log-c", sourceHandle: "execOut", targetHandle: "execIn" },
    ],
  };
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
}

/** The node's own chrome, inside the element that carries the menu gesture. */
function nodeBody(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"] [data-node-role]`)!;
}

function selectedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id")!);
}

function selectNodes(container: HTMLElement, ...ids: string[]) {
  fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
  for (const id of ids) fireEvent.click(nodeEl(container, id));
  fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });
}

const lastGraph = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as GraphDocument;
const ctrl = (letter: string) => ({ key: letter.toLowerCase(), code: `Key${letter}`, ctrlKey: true });
const key = (name: string) => ({ key: name, code: name });

/**
 * Presses and releases a key; true when the browser's own action for it still
 * runs. The release matters: React Flow tracks held keys for Ctrl-click.
 */
function browserKeepsKey(init: KeyboardEventInit, target: Element = document.body): boolean {
  const kept = fireEvent.keyDown(target, init);
  fireEvent.keyUp(target, init);
  return kept;
}

function engage() {
  fireEvent.pointerDown(screen.getByTestId("graph-editor"));
}

describe("graph keyboard shortcuts", () => {
  it("deletes the selected nodes and wires with Delete, like Backspace", () => {
    for (const name of ["Delete", "Backspace"]) {
      const onChange = vi.fn();
      const { container, unmount } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
      engage();
      fireEvent.click(nodeEl(container, "log-b"));
      expect(browserKeepsKey(key(name))).toBe(false);
      expect(lastGraph(onChange).nodes.map((node) => node.id)).toEqual(["log-a", "log-c", "log-d"]);
      expect(lastGraph(onChange).edges.map((edge) => edge.target)).toEqual(["log-c"]);
      unmount();
    }
  });

  it("keeps the graph engaged when the host re-renders after a click", () => {
    const first = vi.fn();
    const second = vi.fn();
    const graph = wiredGraph();
    const { container, rerender } = render(<GraphEditor initialGraph={graph} onChange={first} />);
    engage();
    fireEvent.click(nodeEl(container, "log-d"));
    // The host re-renders on every selection change with a fresh onChange.
    rerender(<GraphEditor initialGraph={graph} onChange={second} />);
    browserKeepsKey(key("Delete"));
    expect(first).not.toHaveBeenCalled();
    expect(lastGraph(second).nodes.map((node) => node.id)).toEqual(["log-a", "log-b", "log-c"]);
  });

  it("copies, pastes and duplicates with Mod+C, Mod+V and Mod+D", () => {
    const onChange = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
      engage();
      // Nothing to paste yet: the browser keeps Mod+V.
      expect(browserKeepsKey(ctrl("V"))).toBe(true);
      selectNodes(container, "log-a", "log-b");
      expect(browserKeepsKey(ctrl("C"))).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(browserKeepsKey(ctrl("V"))).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(1);
      const pasted = lastGraph(onChange);
      expect(pasted.nodes).toHaveLength(6);
      expect(pasted.nodes.slice(4).map((node) => node.position)).toEqual([
        { x: 40, y: 40 },
        { x: 320, y: 40 },
      ]);
      // The copied pair keeps the wire between them and nothing else.
      expect(pasted.edges).toHaveLength(3);
    } finally {
      now.mockRestore();
    }
  });

  it("duplicates the selection as one change and leaves the clipboard alone", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    engage();
    selectNodes(container, "log-a", "log-b");
    expect(browserKeepsKey(ctrl("D"))).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastGraph(onChange).nodes).toHaveLength(6);
    expect(lastGraph(onChange).edges).toHaveLength(3);
    // The copies are the selection now; the clipboard is still empty.
    expect(selectedIds(container)).toHaveLength(2);
    expect(selectedIds(container).every((id) => id.includes("-copy-"))).toBe(true);
    expect(browserKeepsKey(ctrl("V"))).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("gives each copy its own nested data", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [logNode("log-a", 0, { defaults: { value: { x: 1 } } })],
      edges: [],
    };
    const { container } = render(<GraphEditor initialGraph={graph} onChange={onChange} />);
    engage();
    selectNodes(container, "log-a");
    browserKeepsKey(ctrl("C"));
    browserKeepsKey(ctrl("V"));
    browserKeepsKey(ctrl("V"));
    const [original, first, second] = lastGraph(onChange).nodes;
    const valueOf = (node: typeof original) => (node!.data.defaults as { value: { x: number } }).value;
    expect(valueOf(first)).toEqual({ x: 1 });
    valueOf(first).x = 2;
    expect(valueOf(original)).toEqual({ x: 1 });
    expect(valueOf(second)).toEqual({ x: 1 });
  });

  it("claims Mod+D while engaged even with nothing to duplicate", () => {
    const onChange = vi.fn();
    render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    expect(browserKeepsKey(ctrl("D"))).toBe(true);
    engage();
    expect(browserKeepsKey(ctrl("D"))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never copies or deletes protected nodes", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [logNode("input", 0, { __protected: true }), logNode("log-a", 280)],
      edges: [],
    };
    const { container } = render(<GraphEditor initialGraph={graph} onChange={onChange} />);
    engage();
    fireEvent.click(nodeEl(container, "input"));
    browserKeepsKey(ctrl("D"));
    browserKeepsKey(key("Delete"));
    expect(browserKeepsKey(ctrl("C"))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores keys typed into fields, menus and other dialogs, and a graph nothing engaged", () => {
    const onChange = vi.fn();
    const { container } = render(
      <>
        <GraphEditor initialGraph={wiredGraph()} onChange={onChange} />
        <input aria-label="Other field" />
        <div role="menu">
          <button type="button">Menu entry</button>
        </div>
        <div role="dialog">
          <button type="button">Dialog entry</button>
        </div>
      </>,
    );
    fireEvent.click(nodeEl(container, "log-b"));
    expect(browserKeepsKey(key("Delete"))).toBe(true);
    engage();
    for (const target of [
      screen.getByLabelText("Other field"),
      screen.getByRole("button", { name: "Menu entry" }),
      screen.getByRole("button", { name: "Dialog entry" }),
    ]) {
      expect(browserKeepsKey(key("Delete"), target)).toBe(true);
      expect(browserKeepsKey(ctrl("D"), target)).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows the editor's keybinds and the host's opt-outs", () => {
    const onChange = vi.fn();
    const keybinds = { ...DEFAULT_GRAPH_KEYBINDS, duplicate: ["Alt+D"], delete: ["Mod+Backspace"] };
    const view = (extra: Partial<Parameters<typeof GraphEditor>[0]> = {}) => (
      <GraphKeybindsContext.Provider value={keybinds}>
        <GraphEditor initialGraph={wiredGraph()} onChange={onChange} {...extra} />
      </GraphKeybindsContext.Provider>
    );
    const { container, rerender } = render(view());
    engage();
    fireEvent.click(nodeEl(container, "log-d"));
    expect(browserKeepsKey(ctrl("D"))).toBe(true);
    expect(browserKeepsKey(key("Delete"))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(browserKeepsKey({ key: "d", code: "KeyD", altKey: true })).toBe(false);
    expect(lastGraph(onChange).nodes).toHaveLength(5);
    expect(browserKeepsKey({ key: "Backspace", code: "Backspace", ctrlKey: true })).toBe(false);

    // A host without the toolbar's Copy and Paste has no keys for them either,
    // and one that passes deleteKeyCode={null} keeps Delete for its own use.
    onChange.mockClear();
    rerender(view({ hiddenToolbarActions: ["copy", "paste"], deleteKeyCode: null }));
    engage();
    fireEvent.click(nodeEl(container, "log-a"));
    expect(browserKeepsKey({ key: "d", code: "KeyD", altKey: true })).toBe(true);
    expect(browserKeepsKey(ctrl("C"))).toBe(true);
    expect(browserKeepsKey({ key: "Backspace", code: "Backspace", ctrlKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("node context menu", () => {
  const item = (id: string) => screen.queryByTestId(`context-menu-item-${id}`) as HTMLButtonElement | null;

  it("replaces the selection when the menu opens on an unselected node, and lists the graph actions", () => {
    const { container } = render(
      <GraphEditor
        initialGraph={wiredGraph()}
        contextMenuItemsForNode={(id) => [{ id: "rename-event", label: "Rename Event", onSelect: () => id }]}
      />,
    );
    fireEvent.click(nodeEl(container, "log-a"));
    fireEvent.contextMenu(nodeBody(container, "log-c"));
    expect(selectedIds(container)).toEqual(["log-c"]);
    const entries = [...screen.getByTestId("context-menu-panel").querySelectorAll('[data-testid^="context-menu-item-"]')];
    expect(entries.map((entry) => entry.getAttribute("data-testid"))).toEqual(
      ["rename-event", "copy", "paste", "duplicate", "delete", "break-links"].map((id) => `context-menu-item-${id}`),
    );
    // Each label may be followed by its shortcut's keycaps.
    ["Rename Event", "Copy", "Paste", "Duplicate", "Delete", "Break Links"].forEach((label, index) => {
      expect(entries[index]!.textContent).toMatch(new RegExp(`^${label}`));
    });
    expect(item("copy")!.disabled).toBe(false);
    expect(item("paste")!.disabled).toBe(true);
    expect(item("break-links")!.disabled).toBe(false);
  });

  it("keeps a multi-selection when the menu opens on one of its nodes, and acts on all of it", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    selectNodes(container, "log-b", "log-c");
    fireEvent.contextMenu(nodeBody(container, "log-c"));
    expect(selectedIds(container).sort()).toEqual(["log-b", "log-c"]);
    fireEvent.click(item("delete")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastGraph(onChange).nodes.map((node) => node.id)).toEqual(["log-a", "log-d"]);
    expect(lastGraph(onChange).edges).toEqual([]);
  });

  it("copies, pastes and duplicates from the menu", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    fireEvent.contextMenu(nodeBody(container, "log-d"));
    fireEvent.click(item("copy")!);
    fireEvent.contextMenu(nodeBody(container, "log-d"));
    expect(item("paste")!.disabled).toBe(false);
    fireEvent.click(item("paste")!);
    expect(lastGraph(onChange).nodes).toHaveLength(5);
    onChange.mockClear();
    fireEvent.contextMenu(nodeBody(container, "log-a"));
    fireEvent.click(item("duplicate")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastGraph(onChange).nodes).toHaveLength(6);
  });

  it("breaks the links of the node it opened on", () => {
    const onChange = vi.fn();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} onChange={onChange} />);
    fireEvent.contextMenu(nodeBody(container, "log-d"));
    expect(item("break-links")!.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("context-menu-backdrop"));
    fireEvent.contextMenu(nodeBody(container, "log-a"));
    fireEvent.click(item("break-links")!);
    expect(lastGraph(onChange).edges).toEqual([]);
    expect(lastGraph(onChange).nodes).toHaveLength(4);
  });

  it("keeps the restrictions of protected nodes", () => {
    const onChange = vi.fn();
    const graph: GraphDocument = {
      nodes: [logNode("input", 0, { __protected: true }), logNode("log-a", 280)],
      edges: [{ id: "wire", source: "input", target: "log-a", sourceHandle: "execOut", targetHandle: "execIn" }],
    };
    const { container } = render(<GraphEditor initialGraph={graph} onChange={onChange} />);
    fireEvent.contextMenu(nodeBody(container, "input"));
    for (const id of ["copy", "duplicate", "delete"]) expect(item(id)!.disabled).toBe(true);
    expect(item("break-links")!.disabled).toBe(false);
    fireEvent.click(item("delete")!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens on a long press with the same selection rule", () => {
    vi.useFakeTimers();
    const { container } = render(<GraphEditor initialGraph={wiredGraph()} />);
    fireEvent.click(nodeEl(container, "log-a"));
    dispatchTouchDown(nodeBody(container, "log-d"), 5, 5);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(item("copy")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(item("copy")).not.toBeNull();
    expect(selectedIds(container)).toEqual(["log-d"]);
  });

  it("offers only what a host keeps in its toolbar, and nothing on a read-only canvas", () => {
    const { container, rerender } = render(
      <GraphEditor initialGraph={wiredGraph()} hiddenToolbarActions={["copy", "paste", "breakLinks"]} />,
    );
    fireEvent.contextMenu(nodeBody(container, "log-a"));
    expect(item("delete")).not.toBeNull();
    for (const id of ["copy", "paste", "duplicate", "break-links"]) expect(item(id)).toBeNull();
    fireEvent.click(screen.getByTestId("context-menu-backdrop"));
    rerender(<GraphEditor initialGraph={wiredGraph()} readOnly />);
    fireEvent.contextMenu(nodeBody(container, "log-a"));
    expect(item("delete")).toBeNull();
  });
});

describe("host paste hook", () => {
  it("lets the host rewrite or leave out copies, drops their wires and shows its notice", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    let seen: { pasted: GraphPasteElements; current: GraphPasteElements } | undefined;
    const preparePaste = (pasted: GraphPasteElements, current: GraphPasteElements): GraphPasteResult => {
      seen = { pasted, current };
      return {
        nodes: pasted.nodes
          .filter((node) => !node.id.startsWith("log-b-"))
          .map((node) => ({ ...node, data: { ...node.data, message: "Renamed" } })),
        notice: "Log B is already in this graph.",
      };
    };
    const { container } = render(
      <GraphEditor initialGraph={wiredGraph()} preparePaste={preparePaste} onChange={onChange} />,
    );
    engage();
    selectNodes(container, "log-a", "log-b");
    browserKeepsKey(ctrl("D"));
    // The host sees the copies with their new ids and the wire between them.
    expect(seen!.pasted.nodes.map((node) => node.id.replace(/-copy-.*/, ""))).toEqual(["log-a", "log-b"]);
    expect(seen!.pasted.edges).toHaveLength(1);
    expect(seen!.current.nodes.map((node) => node.id)).toEqual(["log-a", "log-b", "log-c", "log-d"]);
    const graph = lastGraph(onChange);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes[4]!.data.message).toBe("Renamed");
    // Only the original wires remain: the copied wire ended at the node left out.
    expect(graph.edges).toHaveLength(2);
    expect(selectedIds(container)).toHaveLength(1);
    expect(screen.getByTestId("graph-notice").textContent).toBe("Log B is already in this graph.");
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId("graph-notice")).toBeNull();
  });

  it("keeps the command handled and the graph untouched when the host leaves every copy out", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GraphEditor
        initialGraph={wiredGraph()}
        preparePaste={() => ({ nodes: [], notice: "Everything is already in this graph." })}
        onChange={onChange}
      />,
    );
    engage();
    selectNodes(container, "log-a");
    expect(browserKeepsKey(ctrl("D"))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(selectedIds(container)).toEqual(["log-a"]);
    expect(screen.getByTestId("graph-notice").textContent).toBe("Everything is already in this graph.");
  });
});

describe("wire feedback", () => {
  function probeGraph(): GraphDocument {
    const floatOut: SerializedPin = { id: "f", name: "f", kind: "data", direction: "out", type: { kind: "float" } };
    const vecIn: SerializedPin = { id: "v", name: "v", kind: "data", direction: "in", type: { kind: "vec3" } };
    const floatIn: SerializedPin = { id: "n", name: "n", kind: "data", direction: "in", type: { kind: "float" } };
    return {
      nodes: [
        { id: "src", type: "debug.log", position: { x: 0, y: 0 }, data: { __pins: [floatOut, execOut] } },
        { id: "dst", type: "debug.log", position: { x: 300, y: 0 }, data: { __pins: [vecIn, floatIn, execIn] } },
        { id: "off", type: "debug.log", position: { x: 600, y: 0 }, data: { __disabled: true, __pins: [floatIn] } },
      ],
      edges: [],
    };
  }

  function renderWithRefusal(props: Partial<Parameters<typeof GraphEditor>[0]> = {}) {
    const captured: { current?: GraphEditorContextValue["connectionRefusal"] } = {};
    function Capture(): ReactNode {
      const { connectionRefusal } = useGraphEditorContext();
      useEffect(() => {
        captured.current = connectionRefusal;
      });
      return null;
    }
    render(<GraphEditor initialGraph={probeGraph()} renderNodeBody={() => <Capture />} {...props} />);
    return (from: [string, string], to: [string, string]) =>
      captured.current!({ nodeId: from[0], pinId: from[1] }, { nodeId: to[0], pinId: to[1] });
  }

  it("says why the hovered pin refuses a wire, naming the output first", () => {
    const refusal = renderWithRefusal();
    expect(refusal(["src", "f"], ["dst", "v"])).toBe("Float does not connect to Vector 3");
    expect(refusal(["dst", "v"], ["src", "f"])).toBe("Float does not connect to Vector 3");
    expect(refusal(["src", "execOut"], ["dst", "n"])).toBe("Exec does not connect to Float");
    expect(refusal(["src", "f"], ["dst", "execIn"])).toBe("Float does not connect to Exec");
    expect(refusal(["src", "f"], ["dst", "n"])).toBeNull();
    expect(refusal(["src", "execOut"], ["dst", "execIn"])).toBeNull();
  });

  it("explains outputs, disabled nodes and host vetoes", () => {
    const refusal = renderWithRefusal({ canConnect: () => false });
    expect(refusal(["src", "f"], ["src", "execOut"])).toBe("Connect an output to an input");
    expect(refusal(["src", "f"], ["off", "n"])).toBe("Disabled nodes don't connect");
    expect(refusal(["src", "f"], ["dst", "n"])).toBe("These pins can't connect");
  });

  describe("replacing an exec wire", () => {
    const tap = (container: HTMLElement, from: string, to: string) => {
      fireEvent.click(container.querySelector(`[data-id="${from}"] [data-handleid="execOut"]`)!);
      fireEvent.click(container.querySelector(`[data-id="${to}"] [data-handleid="execIn"]`)!);
    };
    const graph = (): GraphDocument => ({
      nodes: [logNode("log-a", 0), logNode("log-b", 280), logNode("log-c", 560)],
      edges: [{ id: "e:log-a:execOut:log-b:execIn", source: "log-a", target: "log-b", sourceHandle: "execOut", targetHandle: "execIn" }],
    });

    it("tells the person once the single-wire rule dropped the old wire, for a few seconds", () => {
      vi.useFakeTimers();
      const onChange = vi.fn();
      const { container } = render(<GraphEditor initialGraph={graph()} singleExecOutputOnConnect onChange={onChange} />);
      expect(screen.queryByTestId("graph-notice")).toBeNull();
      tap(container, "log-a", "log-c");
      expect(lastGraph(onChange).edges.map((edge) => edge.target)).toEqual(["log-c"]);
      const notice = screen.getByTestId("graph-notice");
      expect(notice.textContent).toBe("Replaced the existing wire. Use a Sequence to run several.");
      expect(notice.getAttribute("role")).toBe("status");
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId("graph-notice")).toBeNull();
    });

    it("stays quiet when nothing was replaced or the graph fans out", () => {
      const first = render(<GraphEditor initialGraph={graph()} singleExecOutputOnConnect />);
      tap(first.container, "log-b", "log-c");
      expect(screen.queryByTestId("graph-notice")).toBeNull();
      first.unmount();
      const second = render(<GraphEditor initialGraph={graph()} />);
      tap(second.container, "log-a", "log-c");
      expect(screen.queryByTestId("graph-notice")).toBeNull();
    });
  });
});
