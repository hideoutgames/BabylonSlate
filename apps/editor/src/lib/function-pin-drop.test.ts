import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import type { GraphPinDragSource, SerializedPin } from "@haptic/graph-ui";
import { acceptsFunctionPinDrop, addFunctionPinFromDrop } from "./function-pin-drop";
import { addClassMember } from "./class-members";

const FN = "fn";

/** A Class with function Heal (its Input and Output nodes) and an Add and a Print node in its graph. */
function healGraph(extra: { implementsInterface?: boolean } = {}): SerializedGraph {
  const graph = addClassMember({ nodes: [], edges: [] }, "function", "Heal", () => FN, extra.implementsInterface
    ? { implementsInterface: { assetGuid: "iface", methodName: "Heal" } }
    : undefined);
  const slice = graph.functionGraphs![FN]!;
  return {
    ...graph,
    functionGraphs: {
      [FN]: {
        ...slice,
        nodes: [
          ...slice.nodes,
          { id: "add", type: "math.add", position: { x: 0, y: 0 }, data: {} },
          { id: "print", type: "debug.print", position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          ...slice.edges,
          { id: "old", source: "add", sourceHandle: "out", target: "print", targetHandle: "value" },
        ],
      },
    },
  };
}

const pin = (id: string, direction: "in" | "out", kind: "data" | "exec" = "data"): SerializedPin =>
  ({ id, name: id, kind, direction, type: { kind: kind === "exec" ? "exec" : "float" } });
const from = (nodeId: string, dragged: SerializedPin, type: SerializedPin["type"] = dragged.type): GraphPinDragSource =>
  ({ nodeId, pin: dragged, type });

const memberPins = (graph: SerializedGraph | null) => graph?.members?.find((member) => member.id === FN)?.pins;
const sliceOf = (graph: SerializedGraph | null) => graph?.functionGraphs?.[FN];

describe("dropping a wire on a function's Input or Output node", () => {
  it("adds an output of the wire's type to the Output node and wires the dragged output to it", () => {
    const next = addFunctionPinFromDrop(healGraph(), FN, `${FN}-output`, from("add", pin("out", "out")), "Hero");

    expect(memberPins(next)).toEqual([
      { name: "exec", typeId: "exec", direction: "in" },
      { name: "then", typeId: "exec", direction: "out" },
      { name: "Float", typeId: "float", direction: "out" },
    ]);
    // The Output node shows the new pin, and the wire lands on it.
    const output = sliceOf(next)?.nodes.find((node) => node.id === `${FN}-output`);
    expect(output?.data.pins).toEqual(memberPins(next));
    expect(sliceOf(next)?.edges).toContainEqual(
      expect.objectContaining({ source: "add", sourceHandle: "out", target: `${FN}-output`, targetHandle: "Float" }),
    );
  });

  it("adds an input to the Input node wired into the dragged input, replacing that input's wire", () => {
    const next = addFunctionPinFromDrop(healGraph(), FN, `${FN}-input`, from("print", pin("value", "in")), "Hero");

    expect(memberPins(next)?.at(-1)).toEqual({ name: "Float", typeId: "float", direction: "in" });
    const into = sliceOf(next)?.edges.filter((edge) => edge.target === "print" && edge.targetHandle === "value");
    expect(into).toEqual([
      expect.objectContaining({ source: `${FN}-input`, sourceHandle: "Float", target: "print", targetHandle: "value" }),
    ]);
  });

  it("names each new pin after its type, free among all of the function's pins", () => {
    let graph: SerializedGraph | null = healGraph();
    graph = addFunctionPinFromDrop(graph, FN, `${FN}-output`, from("add", pin("out", "out")));
    graph = addFunctionPinFromDrop(graph!, FN, `${FN}-input`, from("print", pin("value", "in")));
    graph = addFunctionPinFromDrop(graph!, FN, `${FN}-output`, from("add", pin("out", "out")));

    expect(memberPins(graph)?.slice(2).map((row) => [row.name, row.direction])).toEqual([
      ["Float", "out"],
      ["Float_1", "in"],
      ["Float_2", "out"],
    ]);
  });

  it("keeps the wire's resolved type: an Array of Actors, a Delegate's signature", () => {
    const actors = { kind: "array", element: { kind: "objectRef", classId: "Actor" } };
    const array = addFunctionPinFromDrop(healGraph(), FN, `${FN}-output`, from("add", pin("out", "out"), actors));
    expect(memberPins(array)?.at(-1)).toEqual({ name: "Object", typeId: "object", typeClassId: "Actor", container: "array", direction: "out" });

    const delegate = { kind: "delegate", inputs: [{ kind: "float" }], outputs: [] };
    const bound = addFunctionPinFromDrop(healGraph(), FN, `${FN}-input`, from("print", pin("value", "in"), delegate));
    expect(memberPins(bound)?.at(-1)).toMatchObject({ name: "Delegate", typeId: "delegate", signature: [{ typeId: "float" }] });
  });

  it.each([
    ["an output dragged onto the Input node", `${FN}-input`, from("add", pin("out", "out"))],
    ["an input dragged onto the Output node", `${FN}-output`, from("print", pin("value", "in"))],
    ["any other node", "print", from("add", pin("out", "out"))],
    ["an exec wire, which connects to the node's own exec pin", `${FN}-output`, from("add", pin("then", "out", "exec"))],
    ["a Wildcard nothing has resolved", `${FN}-output`, from("add", pin("out", "out"), { kind: "wildcard" })],
    ["a Map, whose key type a pin row cannot keep", `${FN}-output`, from("add", pin("out", "out"), { kind: "map", key: { kind: "string" }, value: { kind: "float" } })],
  ])("adds nothing for %s", (_label, target, source) => {
    expect(acceptsFunctionPinDrop(healGraph(), FN, target, source)).toBe(false);
    expect(addFunctionPinFromDrop(healGraph(), FN, target, source)).toBeNull();
  });

  it("adds nothing to an Interface implementation, whose signature is the interface's", () => {
    const graph = healGraph({ implementsInterface: true });
    expect(acceptsFunctionPinDrop(graph, FN, `${FN}-output`, from("add", pin("out", "out")))).toBe(false);
  });
});
