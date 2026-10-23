import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphBreakpoints } from "./graph-breakpoints";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(cleanup);

const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const execOut: SerializedPin = { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } };
const valueOut: SerializedPin = { id: "out", name: "Value", kind: "data", direction: "out", type: { kind: "float" } };

/** A Print String in an exec chain and a pure node, which no execution reaches. */
const graph: GraphDocument = {
  nodes: [
    { id: "print", type: "debug.log", position: { x: 0, y: 0 }, data: { __pins: [execIn, execOut] } },
    { id: "pure", type: "math.add", position: { x: 400, y: 0 }, data: { __pins: [valueOut] } },
  ],
  edges: [],
};

function hostBreakpoints(): { view: GraphBreakpoints; set: Set<string> } {
  const set = new Set<string>();
  const listeners = new Set<() => void>();
  const view: GraphBreakpoints = {
    state: (nodeId) => (set.has(nodeId) ? "enabled" : null),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    toggle: (nodeId) => {
      if (!set.delete(nodeId)) set.add(nodeId);
      for (const listener of listeners) listener();
    },
  };
  return { view, set };
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
    expect([...set]).toEqual(["print"]);
    expect(dot(container, "print")?.dataset.breakpoint).toBe("enabled");
    expect(dot(container, "pure")).toBeNull();

    act(pressF9);
    expect(set.size).toBe(0);
    expect(dot(container, "print")?.dataset.breakpoint).toBeUndefined();
  });

  it("toggle from the node's title-bar dot", () => {
    const { view, set } = hostBreakpoints();
    const { container } = render(<GraphEditor initialGraph={graph} breakpoints={view} />);
    act(() => { fireEvent.click(dot(container, "print")!); });
    expect([...set]).toEqual(["print"]);
    expect(dot(container, "print")?.getAttribute("aria-label")).toBe("Remove Breakpoint");
  });
});
