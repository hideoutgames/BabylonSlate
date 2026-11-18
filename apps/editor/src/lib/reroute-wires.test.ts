import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { edgesIntoNodeThroughKnots, isInputWired, wiredSource, wiredTargets } from "./reroute-wires";
import { canRenameCustomEvent } from "./class-members";
import { watchablePins } from "./watch-menu";

type Node = SerializedGraph["nodes"][number];
const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const knot = (id: string) => node(id, "flow.reroute", { __reroute: true });
const wire = (id: string, from: string, to: string) => {
  const [source, sourceHandle] = from.split(".") as [string, string];
  const [target, targetHandle] = to.split(".") as [string, string];
  return { id, source, sourceHandle, target, targetHandle };
};

describe("wires through Reroute knots", () => {
  const graph: SerializedGraph = {
    nodes: [node("number", "literal.makeFloat"), knot("k1"), knot("k2"), knot("loose"), node("print", "debug.print")],
    edges: [
      wire("a", "number.out", "k1.in"),
      wire("b", "k1.out", "k2.in"),
      wire("c", "k2.out", "print.value"),
      wire("d", "loose.out", "print.key"),
    ],
  };

  it("reads an input's real source and an output's real targets", () => {
    expect(wiredSource(graph, "print", "value")).toEqual({ nodeId: "number", pinId: "out" });
    expect(wiredTargets(graph, "number", "out")).toEqual([{ nodeId: "print", pinId: "value" }]);
  });

  it("treats an input fed only by a knot that nothing feeds as unwired", () => {
    expect(isInputWired(graph, "print", "value")).toBe(true);
    expect(isInputWired(graph, "print", "key")).toBe(false);
    expect(isInputWired(graph, "print", "duration")).toBe(false);
  });

  it("rewrites only the wires into one node to leave their real sources", () => {
    expect(edgesIntoNodeThroughKnots(graph, "print")).toEqual([
      wire("a", "number.out", "k1.in"),
      wire("b", "k1.out", "k2.in"),
      { ...wire("c", "k2.out", "print.value"), source: "number", sourceHandle: "out" },
    ]);
  });
});

describe("Reroute knots in editor checks", () => {
  it("keeps a custom event that calls its parent through a knot from being renamed", () => {
    const graph: SerializedGraph = {
      nodes: [node("evt", "flow.event.custom", { name: "Opened" }), knot("k"), node("parent", "flow.event.callParent")],
      edges: [wire("a", "evt.execOut", "k.in"), wire("b", "k.out", "parent.execIn")],
    };
    expect(canRenameCustomEvent(graph, "evt")).toBe(false);
    expect(canRenameCustomEvent({ ...graph, edges: graph.edges.slice(0, 1) }, "evt")).toBe(true);
  });

  it("offers no pin of a knot to Watch Pin", () => {
    const pins = [
      { id: "in", name: "In", kind: "data", direction: "in", type: { kind: "float" }, anyKind: true },
      { id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "float" }, anyKind: true },
    ];
    expect(watchablePins({ __pins: pins, __pure: true, __reroute: true }, () => true)).toEqual([]);
    expect(watchablePins({ __pins: pins, __pure: true }, () => true)).toEqual([{ id: "out", direction: "out", name: "Out" }]);
  });
});
