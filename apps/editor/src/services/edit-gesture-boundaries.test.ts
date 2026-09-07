import { expect, it } from "vitest";
import { DocumentEditStack, SetNodeDataCommand } from "@babylonslate/edit";
import type { SerializedGraph } from "@babylonslate/core";
import { attachEditGestureBoundaries } from "./edit-gesture-boundaries";

it("separates pointer gestures while retaining all updates in a multitouch gesture", () => {
  const stack = new DocumentEditStack<SerializedGraph>({
    maxEntries: 10,
    maxBytes: 10000,
  });
  const detach = attachEditGestureBoundaries(() => stack.endGesture());
  let graph: SerializedGraph = {
    nodes: [
      {
        id: "n",
        type: "literal.makeFloat",
        position: { x: 0, y: 0 },
        data: { value: 0 },
      },
    ],
    edges: [],
  };
  const edit = (value: number) => {
    graph = stack.apply(
      graph,
      new SetNodeDataCommand("n", graph.nodes[0]!.data, { value }),
    ).doc;
  };
  const pointer = (type: string, pointerId: number) =>
    window.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  try {
    pointer("pointerdown", 1);
    edit(1);
    pointer("pointerdown", 2);
    edit(2);
    pointer("pointerup", 1);
    pointer("pointerup", 2);
    pointer("pointerdown", 3);
    edit(3);
    edit(4);
    pointer("pointerup", 3);
    graph = stack.undo(graph)!.doc;
    expect(graph.nodes[0]!.data.value).toBe(2);
    expect(stack.undo(graph)!.doc.nodes[0]!.data.value).toBe(0);
  } finally {
    detach();
  }
});

it("groups typing until an input commit or focus leaves the field", () => {
  const stack = new DocumentEditStack<SerializedGraph>({
    maxEntries: 10,
    maxBytes: 10000,
  });
  const detach = attachEditGestureBoundaries(() => stack.endGesture());
  const input = document.createElement("input");
  document.body.append(input);
  let graph: SerializedGraph = {
    nodes: [
      {
        id: "n",
        type: "literal.makeFloat",
        position: { x: 0, y: 0 },
        data: { value: 0 },
      },
    ],
    edges: [],
  };
  const edit = (value: number) => {
    graph = stack.apply(
      graph,
      new SetNodeDataCommand("n", graph.nodes[0]!.data, { value }),
    ).doc;
  };
  try {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "4", bubbles: true }),
    );
    edit(4);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", bubbles: true }),
    );
    edit(42);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    edit(43);
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    edit(44);
    graph = stack.undo(graph)!.doc;
    expect(graph.nodes[0]!.data.value).toBe(43);
    graph = stack.undo(graph)!.doc;
    expect(graph.nodes[0]!.data.value).toBe(42);
    expect(stack.undo(graph)!.doc.nodes[0]!.data.value).toBe(0);
  } finally {
    detach();
    input.remove();
  }
});
