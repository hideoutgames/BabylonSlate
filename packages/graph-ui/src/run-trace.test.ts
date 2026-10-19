import { describe, expect, it } from "vitest";
import {
  dataWiresRead,
  pinShowsValue,
  resolvePinValue,
  type GraphRunTrace,
  type RunGraph,
} from "./run-trace";

type Pin = { id: string; kind: "exec" | "data"; direction: "in" | "out" };
const exec = (id: string, direction: "in" | "out"): Pin => ({ id, kind: "exec", direction });
const data = (id: string, direction: "in" | "out"): Pin => ({ id, kind: "data", direction });

function node(id: string, pins: Pin[], pure = false) {
  return { id, data: { __pins: pins.map((pin) => ({ ...pin, name: pin.id, type: { kind: "float" } })), ...(pure ? { __pure: true } : {}) } };
}
function wire(id: string, source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id, source, sourceHandle, target, targetHandle };
}

/**
 * make --exec--> log, with Log.message read from Add.sum, a pure node that adds Make.value to Scale.out
 * (Scale is pure too); Log's other input is unwired.
 */
function graph(): RunGraph {
  return {
    nodes: [
      node("make", [exec("then", "out"), data("value", "out")]),
      node("scale", [data("factor", "out")], true),
      node("add", [data("a", "in"), data("b", "in"), data("sum", "out")], true),
      node("log", [exec("exec", "in"), data("message", "in"), data("extra", "in")]),
    ],
    edges: [
      wire("e-exec", "make", "then", "log", "exec"),
      wire("d-a", "make", "value", "add", "a"),
      wire("d-b", "scale", "factor", "add", "b"),
      wire("d-msg", "add", "sum", "log", "message"),
    ],
  };
}

function traceOf(values: Record<string, string>): Pick<GraphRunTrace, "value"> {
  return { value: (nodeId, pinId, direction) => values[`${nodeId}.${pinId}.${direction}`] };
}

describe("dataWiresRead", () => {
  it("follows the wires into a node's data inputs through the pure nodes feeding them", () => {
    expect(dataWiresRead(graph(), "log").map((edge) => edge.id).sort()).toEqual(["d-a", "d-b", "d-msg"]);
  });

  it("is empty for a node with no data inputs wired, and never counts an exec wire", () => {
    expect(dataWiresRead(graph(), "make")).toEqual([]);
    expect(dataWiresRead(graph(), "scale")).toEqual([]);
  });

  it("stops at a cycle of pure nodes", () => {
    const cyclic: RunGraph = {
      nodes: [node("p", [data("in", "in"), data("out", "out")], true), node("q", [data("in", "in"), data("out", "out")], true)],
      edges: [wire("pq", "p", "out", "q", "in"), wire("qp", "q", "out", "p", "in")],
    };
    expect(dataWiresRead(cyclic, "p").map((edge) => edge.id).sort()).toEqual(["pq", "qp"]);
  });
});

describe("pinShowsValue", () => {
  it("covers data outputs and wired data inputs, not exec pins or unwired inputs", () => {
    const g = graph();
    expect(pinShowsValue(g, "make", "value", "out")).toBe(true);
    expect(pinShowsValue(g, "add", "a", "in")).toBe(true);
    expect(pinShowsValue(g, "log", "extra", "in")).toBe(false);
    expect(pinShowsValue(g, "log", "exec", "in")).toBe(false);
    expect(pinShowsValue(g, "make", "then", "out")).toBe(false);
  });
});

describe("resolvePinValue", () => {
  it("reports what a node that ran read and produced", () => {
    const trace = traceOf({ "log.message.in": "7", "make.value.out": "3" });
    expect(resolvePinValue(trace, graph(), "log", "message", "in")).toBe("7");
    expect(resolvePinValue(trace, graph(), "make", "value", "out")).toBe("3");
  });

  it("shows a pure node's output as the value a node that ran read from it", () => {
    expect(resolvePinValue(traceOf({ "log.message.in": "7" }), graph(), "add", "sum", "out")).toBe("7");
  });

  it("shows a wired input as what its source produced", () => {
    const trace = traceOf({ "make.value.out": "3" });
    expect(resolvePinValue(trace, graph(), "add", "a", "in")).toBe("3");
  });

  it("falls back to what a node that ran read from the source when the source is pure", () => {
    // Scale reports nothing itself; Add reads it but is pure too, so nothing records Add.b. Not known.
    expect(resolvePinValue(traceOf({ "log.message.in": "7" }), graph(), "add", "b", "in")).toBeUndefined();
    expect(resolvePinValue(traceOf({}), graph(), "make", "value", "out")).toBeUndefined();
  });

  it("is unknown for an unwired input", () => {
    expect(resolvePinValue(traceOf({}), graph(), "log", "extra", "in")).toBeUndefined();
  });
});
