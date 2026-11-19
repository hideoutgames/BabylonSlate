import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import { estimateGraphNodeSize, graphNodesBounds } from "./graph-virtualize";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(cleanup);

const item0: SerializedPin = { id: "item0", name: "Item 0", kind: "data", direction: "in", type: { kind: "float" } };
const arrayOut: SerializedPin = { id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "float" } };
const execIn: SerializedPin = { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } };
const then0: SerializedPin = { id: "then0", name: "then_0", kind: "exec", direction: "out", type: { kind: "exec" } };

function graphOf(addPin?: { side: "in" | "out"; label: string }): GraphDocument {
  return {
    nodes: [
      {
        id: "make",
        type: "array.make",
        position: { x: 0, y: 0 },
        data: { __pins: [item0, arrayOut], ...(addPin ? { __addPin: addPin } : {}) },
      },
      {
        id: "seq",
        type: "flow.sequence",
        position: { x: 0, y: 400 },
        data: { __pins: [execIn, then0], __addPin: { side: "out", label: "Add Pin" } },
      },
    ],
    edges: [],
  };
}

const nodeEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const addPinButton = (container: HTMLElement, id: string) =>
  nodeEl(container, id).querySelector<HTMLButtonElement>('[data-testid="graph-node-add-pin"]');

describe("node Add Pin control", () => {
  it("shows only on nodes that declare it, when the host handles it and the canvas is editable", () => {
    const onAddPin = vi.fn();
    const declared = render(<GraphEditor initialGraph={graphOf({ side: "in", label: "Add Pin" })} onAddPin={onAddPin} />);
    const button = addPinButton(declared.container, "make");
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("aria-label")).toBe("Add Pin");
    expect(button?.textContent).toBe("Add Pin");
    declared.unmount();

    const undeclared = render(<GraphEditor initialGraph={graphOf()} onAddPin={onAddPin} />);
    expect(addPinButton(undeclared.container, "make")).toBeNull();
    expect(addPinButton(undeclared.container, "seq")).not.toBeNull();
    undeclared.unmount();

    const noHost = render(<GraphEditor initialGraph={graphOf({ side: "in", label: "Add Pin" })} />);
    expect(addPinButton(noHost.container, "make")).toBeNull();
    noHost.unmount();

    const readOnly = render(<GraphEditor initialGraph={graphOf({ side: "in", label: "Add Pin" })} onAddPin={onAddPin} readOnly />);
    expect(addPinButton(readOnly.container, "make")).toBeNull();
  });

  it("sits under the inputs or the outputs, as declared, and is no wire target", () => {
    const { container } = render(
      <GraphEditor initialGraph={graphOf({ side: "in", label: "Add Pin" })} onAddPin={vi.fn()} />,
    );
    const inRow = addPinButton(container, "make")!.closest("[data-add-pin-side]")!;
    const outRow = addPinButton(container, "seq")!.closest("[data-add-pin-side]")!;
    expect(inRow.getAttribute("data-add-pin-side")).toBe("in");
    expect(inRow.className).toContain("justify-start");
    expect(outRow.getAttribute("data-add-pin-side")).toBe("out");
    expect(outRow.className).toContain("justify-end");
    expect(inRow.querySelector(".react-flow__handle")).toBeNull();
    // The last row of the pin list.
    const pinList = inRow.parentElement!;
    expect(pinList.lastElementChild).toBe(inRow);
  });

  it("adds one pin per click, Enter or Space, for its own node", () => {
    const onAddPin = vi.fn();
    const { container } = render(
      <GraphEditor initialGraph={graphOf({ side: "in", label: "Add Pin" })} onAddPin={onAddPin} />,
    );
    const button = addPinButton(container, "make")!;
    expect(button.tabIndex).toBe(0);

    act(() => { fireEvent.click(button); });
    expect(onAddPin.mock.calls).toEqual([["make"]]);

    act(() => { fireEvent.keyDown(button, { key: "Enter", code: "Enter" }); });
    act(() => { fireEvent.keyDown(button, { key: " ", code: "Space" }); });
    act(() => { fireEvent.keyDown(button, { key: "Enter", code: "Enter", repeat: true }); });
    act(() => { fireEvent.keyDown(button, { key: "a", code: "KeyA" }); });
    expect(onAddPin.mock.calls).toEqual([["make"], ["make"], ["make"]]);

    act(() => { fireEvent.click(addPinButton(container, "seq")!); });
    expect(onAddPin).toHaveBeenLastCalledWith("seq");
  });

  it("neither selects nor drags the node when pressed", () => {
    const onSelectionChange = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <GraphEditor
        initialGraph={graphOf({ side: "in", label: "Add Pin" })}
        onAddPin={vi.fn()}
        onSelectionChange={onSelectionChange}
        onChange={onChange}
      />,
    );
    const button = addPinButton(container, "make")!;
    act(() => {
      fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(button, { clientX: 80, clientY: 80 });
      fireEvent.mouseUp(button, { clientX: 80, clientY: 80 });
      fireEvent.pointerUp(button, { pointerId: 1, button: 0, clientX: 80, clientY: 80 });
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    });
    expect(nodeEl(container, "make").classList.contains("selected")).toBe(false);
    expect(onSelectionChange.mock.calls.some(([ids]) => ids.length > 0)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Add Pin size estimate", () => {
  it("counts the control as one more pin row for an unmeasured node", () => {
    const pins = [{ direction: "in" }, { direction: "in" }, { direction: "in" }, { direction: "out" }];
    // 47 above the rows, 44 per row and 5 below: three rows, then four with the control.
    expect(estimateGraphNodeSize(pins).height).toBe(184);
    expect(estimateGraphNodeSize(pins, { __addPin: { side: "in", label: "Add Pin" } }).height).toBe(228);
    expect(graphNodesBounds([{
      id: "make",
      position: { x: 0, y: 0 },
      data: { __pins: pins, __addPin: { side: "out", label: "Add Pin" } },
    }])?.height).toBe(228);
  });
});
