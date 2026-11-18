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
    // Scale reports nothing and Add, which reads it, is pure and reports nothing either (a graph whose
    // pure nodes do not record). Not known.
    expect(resolvePinValue(traceOf({ "log.message.in": "7" }), graph(), "add", "b", "in")).toBeUndefined();
    expect(resolvePinValue(traceOf({}), graph(), "make", "value", "out")).toBeUndefined();
  });

  it("is unknown for an unwired input", () => {
    expect(resolvePinValue(traceOf({}), graph(), "log", "extra", "in")).toBeUndefined();
  });
});

describe("Reroute knots", () => {
  const knot = (id: string) => ({
    id,
    data: {
      __reroute: true,
      __pins: [
        { id: "in", name: "In", kind: "data", direction: "in", type: { kind: "resolvingWildcard" }, anyKind: true },
        { id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "resolvingWildcard" }, anyKind: true },
      ],
    },
  });
  /** make --exec--> k-exec --> log; make.value --> k1 --> k2 --> log.message. Knots are not stamped pure. */
  function knotted(): RunGraph {
    return {
      nodes: [
        node("make", [exec("then", "out"), data("value", "out")]),
        knot("k1"),
        knot("k2"),
        knot("k-exec"),
        node("log", [exec("exec", "in"), data("message", "in")]),
      ],
      edges: [
        wire("e1", "make", "then", "k-exec", "in"),
        wire("e2", "k-exec", "out", "log", "exec"),
        wire("d1", "make", "value", "k1", "in"),
        wire("d2", "k1", "out", "k2", "in"),
        wire("d3", "k2", "out", "log", "message"),
      ],
    };
  }

  it("light every segment of a data path a node read through them", () => {
    expect(dataWiresRead(knotted(), "log").map((edge) => edge.id).sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("show the real source's value on every segment, before or after a knot", () => {
    const produced = traceOf({ "make.value.out": "3" });
    expect(resolvePinValue(produced, knotted(), "log", "message", "in")).toBe("3");
    expect(resolvePinValue(produced, knotted(), "k1", "out", "out")).toBe("3");
    expect(resolvePinValue(produced, knotted(), "k2", "in", "in")).toBe("3");
    // Only what the reader got is known: the source output and the knots show it.
    const read = traceOf({ "log.message.in": "9" });
    expect(resolvePinValue(read, knotted(), "make", "value", "out")).toBe("9");
    expect(resolvePinValue(read, knotted(), "k1", "in", "in")).toBe("9");
  });

  it("show values only on knots carrying data", () => {
    expect(pinShowsValue(knotted(), "k2", "out", "out")).toBe(true);
    expect(pinShowsValue(knotted(), "k-exec", "in", "in")).toBe(false);
    expect(pinShowsValue(knotted(), "k-exec", "out", "out")).toBe(false);
  });
});
