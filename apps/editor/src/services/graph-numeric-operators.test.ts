import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { filterPaletteForPin, paletteConnectPin, type SerializedPin } from "@haptic/graph-ui";
import {
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
  scriptPinCompatibility,
  validateSerializedGraph,
} from "./graph-validation";
import { retypeNumericOperatorNodes } from "./graph-node-refresh";

const registry = createDefaultNodeRegistry();
type Node = SerializedGraph["nodes"][number];

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data });
const wire = (id: string, from: string, to: string) => {
  const [source, sourceHandle] = from.split(".") as [string, string];
  const [target, targetHandle] = to.split(".") as [string, string];
  return { id, source, sourceHandle, target, targetHandle };
};
/** A Vector3 source: Make Vector3's Out. */
const vec3Source = () => node("vec", "vector.make3");
const intSource = () => node("int", "literal.makeInt");
const floatSource = () => node("float", "literal.makeFloat");

function hydrated(graph: SerializedGraph, nodeId: string) {
  const data = hydrateSerializedGraphForEditor(graph, registry).nodes.find((entry) => entry.id === nodeId)!.data;
  const pins = data.__pins as SerializedPin[];
  return { data, type: (pinId: string) => pins.find((pin) => pin.id === pinId)?.type.kind };
}

describe("numeric operator connection rule", () => {
  const rule = scriptPinCompatibility();
  const out = (kind: string): SerializedPin => ({ id: "out", name: "Out", kind: "data", direction: "out", type: { kind } });
  const operand = (properties: Record<string, unknown>, pinId = "b") =>
    registry.get("math.mul")!.pins(properties).find((pin) => pin.id === pinId) as SerializedPin;

  it("takes a Float on a Vector3 operand, and any number or Vector3 against a Vector3 operand", () => {
    const vectors = { aType: "vec3", bType: "vec3" };
    expect(rule(out("float"), operand(vectors))).toBe(true);
    expect(rule(out("int"), operand(vectors))).toBe(true);
    expect(rule(out("vec3"), operand(vectors))).toBe(true);
    expect(rule(out("vec2"), operand(vectors))).toBe(false);
    expect(rule(out("string"), operand(vectors))).toBe(false);
  });

  it("takes any vector size while the other operand is a number", () => {
    expect(rule(out("vec2"), operand({ aType: "float", bType: "vec3" }))).toBe(true);
    expect(rule(out("vec4"), operand({ aType: "int" }))).toBe(true);
  });

  it("judges pins without accepts as before", () => {
    const plain = { ...operand({}), accepts: undefined };
    expect(rule(out("int"), plain)).toBe(true);
    expect(rule(out("vec3"), plain)).toBe(false);
  });
});

describe("numeric operator retype on connect", () => {
  it("makes a fresh node dropped on a Vector3 wire work on two Vector3s, with no validation error", () => {
    const graph: SerializedGraph = {
      nodes: [vec3Source(), node("mul", "math.mul")],
      edges: [wire("w", "vec.out", "mul.a")],
    };
    const mul = hydrated(graph, "mul");
    expect([mul.type("a"), mul.type("b"), mul.type("out")]).toEqual(["vec3", "vec3", "vec3"]);
    expect(mul.data).toMatchObject({ aType: "vec3", bType: "vec3" });
    expect(validateSerializedGraph(graph, { assetGuid: "g", graphId: "g" }).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("gives Vector3 × Float when a Float is wired into B and A is wired", () => {
    const graph: SerializedGraph = {
      nodes: [vec3Source(), floatSource(), node("mul", "math.mul", { aType: "vec3", bType: "vec3", "default:b": { x: 1, y: 2, z: 3 } })],
      edges: [wire("a", "vec.out", "mul.a"), wire("b", "float.out", "mul.b")],
    };
    const mul = hydrated(graph, "mul");
    expect([mul.type("a"), mul.type("b"), mul.type("out")]).toEqual(["vec3", "float", "vec3"]);
    // The stored Vector3 value of B no longer fits its type.
    expect(mul.data).not.toHaveProperty("default:b");
  });

  it("gives Vector3 × Float when a Float is wired into B and A is unwired with no value", () => {
    const graph: SerializedGraph = {
      nodes: [floatSource(), node("mul", "math.mul", { aType: "vec3", bType: "vec3" })],
      edges: [wire("b", "float.out", "mul.b")],
    };
    const mul = hydrated(graph, "mul");
    expect([mul.type("a"), mul.type("b"), mul.type("out")]).toEqual(["vec3", "float", "vec3"]);
  });

  it("keeps a Float operand Float when Integers are wired into it", () => {
    const graph: SerializedGraph = {
      nodes: [intSource(), node("int2", "literal.makeInt"), node("div", "math.div", { aType: "float", bType: "float" })],
      edges: [wire("a", "int.out", "div.a"), wire("b", "int2.out", "div.b")],
    };
    const div = hydrated(graph, "div");
    expect([div.type("a"), div.type("b"), div.type("out")]).toEqual(["float", "float", "float"]);
    expect(validateSerializedGraph(graph, { assetGuid: "g", graphId: "g" }).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("leaves an unwired operand that has a value at its own type", () => {
    const graph: SerializedGraph = {
      nodes: [vec3Source(), node("add", "math.add", { "default:b": 2 })],
      edges: [wire("w", "vec.out", "add.a")],
    };
    const add = hydrated(graph, "add");
    expect([add.type("a"), add.type("b"), add.type("out")]).toEqual(["vec3", "float", "vec3"]);
    expect(add.data["default:b"]).toBe(2);
  });

  it("follows a retyped operator into the operator it feeds, through a Reroute knot", () => {
    const graph: SerializedGraph = {
      nodes: [vec3Source(), node("first", "math.add"), node("knot", "flow.reroute"), node("second", "math.negate")],
      edges: [wire("a", "vec.out", "first.a"), wire("b", "first.out", "knot.in"), wire("c", "knot.out", "second.in")],
    };
    expect(hydrated(graph, "second").type("out")).toBe("vec3");
  });

  it("makes two Integers an Integer operation", () => {
    const graph: SerializedGraph = {
      nodes: [intSource(), node("int2", "literal.makeInt"), node("div", "math.div")],
      edges: [wire("a", "int.out", "div.a"), wire("b", "int2.out", "div.b")],
    };
    expect(hydrated(graph, "div").type("out")).toBe("int");
  });

  it("keeps an unwired operand's type once its wire is removed", () => {
    const connected: SerializedGraph = {
      nodes: [vec3Source(), node("add", "math.add")],
      edges: [wire("w", "vec.out", "add.a")],
    };
    // The editor saves the node as it shows it, then the wire goes.
    const shown = hydrateSerializedGraphForEditor(connected, registry);
    const add = hydrated({ nodes: shown.nodes, edges: [] }, "add");
    expect([add.type("a"), add.type("b")]).toEqual(["vec3", "vec3"]);
  });

  it("changes nothing when the saved types already match the wires, so a refresh is stable", () => {
    const graph: SerializedGraph = {
      nodes: [vec3Source(), node("add", "math.add")],
      edges: [wire("w", "vec.out", "add.a")],
    };
    const once = hydrateSerializedGraphForEditor(graph, registry);
    expect(retypeNumericOperatorNodes(once.nodes, once.edges, registry)).toBe(once.nodes);
    const twice = hydrateSerializedGraphForEditor(once, registry);
    expect(twice.nodes.find((entry) => entry.id === "add")!.data).toEqual(once.nodes.find((entry) => entry.id === "add")!.data);
  });
});

describe("Add Node from a dragged Vector3 wire", () => {
  it("offers Multiply, which works on Vector3s once connected", () => {
    const dragged: SerializedPin = { id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "vec3" } };
    const rule = scriptPinCompatibility();
    const offered = filterPaletteForPin(scriptPaletteNodes(registry), dragged, rule);
    const multiply = offered.find((row) => row.id === "math.mul");
    expect(multiply).toBeDefined();
    const target = paletteConnectPin(multiply!, dragged, rule);
    expect(target?.id).toBe("a");
    const graph: SerializedGraph = {
      nodes: [vec3Source(), node("mul", "math.mul", { ...multiply!.defaultData })],
      edges: [wire("w", `vec.out`, `mul.${target!.id}`)],
    };
    const mul = hydrated(graph, "mul");
    expect([mul.type("a"), mul.type("b"), mul.type("out")]).toEqual(["vec3", "vec3", "vec3"]);
  });
});
