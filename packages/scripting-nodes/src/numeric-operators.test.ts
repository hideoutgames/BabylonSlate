import { describe, expect, it } from "vitest";
import {
  compileGraph,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import {
  numericResultType,
  retypeNumericOperands,
  type NumericOperandType,
} from "./numeric-operators";

const registry = createDefaultNodeRegistry();

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties };
}

const kinds = (pins: readonly { kind?: string }[] | undefined) => pins?.map((type) => type.kind);

function pinsOf(typeId: string, properties: Record<string, unknown>) {
  const pins = registry.get(typeId)!.pins(properties);
  return Object.fromEntries(pins.map((pin) => [pin.id, { type: pin.type.kind, accepts: kinds(pin.accepts) }]));
}

/** Compiles Begin Play → Log of the operator's Out with literal operands and returns what it logged. */
function run(typeId: string, properties: Record<string, unknown>): unknown {
  const graph: LogicGraph = {
    id: "g",
    kind: "event",
    nodes: [node("begin", "flow.event.beginPlay"), node("op", typeId, properties), node("log", "debug.log")],
    edges: [
      { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
      { id: "e2", sourceNodeId: "op", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
    ],
  };
  const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+function\s+/g, "function ");
  const logged: unknown[] = [];
  (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
    formatValue: (value: unknown) => value,
    log: (_severity: string, _category: string, value: unknown) => logged.push(value),
  });
  return logged[0];
}

const v2 = (x: number, y: number) => ({ x, y });
const v3 = (x: number, y: number, z: number) => ({ x, y, z });
const v4 = (x: number, y: number, z: number, w: number) => ({ x, y, z, w });

describe("numeric operator pins", () => {
  const ALL = ["int", "float", "vec2", "vec3", "vec4"];

  it("reads a missing operand type as Float and lets each operand take any number or vector type", () => {
    expect(pinsOf("math.add", {})).toEqual({
      a: { type: "float", accepts: ALL },
      b: { type: "float", accepts: ALL },
      out: { type: "float", accepts: undefined },
    });
  });

  it.each([
    ["int", "int", "int"],
    ["int", "float", "float"],
    ["float", "int", "float"],
    ["vec3", "vec3", "vec3"],
    ["vec2", "float", "vec2"],
    ["int", "vec4", "vec4"],
  ] as const)("%s with %s gives %s", (aType, bType, out) => {
    expect(pinsOf("math.mul", { aType, bType })).toMatchObject({ a: { type: aType }, b: { type: bType }, out: { type: out } });
  });

  it("holds the other operand to numbers or the same vector once one operand is a vector", () => {
    expect(pinsOf("math.sub", { aType: "vec3", bType: "float" })).toMatchObject({
      a: { accepts: ALL },
      b: { accepts: ["int", "float", "vec3"] },
    });
    expect(pinsOf("math.div", { aType: "vec2", bType: "vec2" })).toMatchObject({
      a: { accepts: ["int", "float", "vec2"] },
      b: { accepts: ["int", "float", "vec2"] },
    });
  });

  it("keeps Modulo to numbers and lets Negate take any type", () => {
    expect(pinsOf("math.mod", { aType: "int", bType: "int" })).toMatchObject({
      a: { type: "int", accepts: ["int", "float"] },
      b: { type: "int", accepts: ["int", "float"] },
      out: { type: "int" },
    });
    expect(pinsOf("math.negate", { inType: "vec4" })).toEqual({
      in: { type: "vec4", accepts: ALL },
      out: { type: "vec4", accepts: undefined },
    });
  });

  it("has no result for two different vector sizes", () => {
    expect(numericResultType("vec2", "vec3")).toBeUndefined();
    expect(numericResultType("vec4", "vec4")).toBe("vec4");
  });
});

describe("numeric operator results", () => {
  it.each([
    ["math.add", "int", "int", 2, 3, 5],
    ["math.add", "int", "float", 2, 0.5, 2.5],
    ["math.sub", "float", "int", 2.5, 1, 1.5],
    ["math.mul", "int", "int", -4, 3, -12],
    ["math.div", "int", "int", 7, 2, 3],
    ["math.div", "int", "int", -7, 2, -3],
    ["math.div", "int", "float", 7, 2, 3.5],
    ["math.div", "float", "float", 1, 0, 0],
    ["math.mod", "int", "int", 7, 0, 0],
    ["math.mod", "float", "int", 7.5, 2, 1.5],
    ["math.mod", "float", "float", 7.5, 0, 0],
    ["math.add", "vec3", "vec3", v3(1, 2, 3), v3(10, 20, 30), v3(11, 22, 33)],
    ["math.sub", "vec3", "vec3", v3(1, 2, 3), v3(10, 20, 30), v3(-9, -18, -27)],
    ["math.mul", "vec3", "vec3", v3(1, 2, 3), v3(2, 0, -1), v3(2, 0, -3)],
    ["math.div", "vec3", "vec3", v3(4, 2, 3), v3(2, 0, 3), v3(2, 0, 1)],
    ["math.add", "vec3", "float", v3(1, 2, 3), 1, v3(2, 3, 4)],
    ["math.add", "float", "vec3", 1, v3(1, 2, 3), v3(2, 3, 4)],
    ["math.sub", "vec3", "float", v3(1, 2, 3), 1, v3(0, 1, 2)],
    ["math.sub", "float", "vec3", 1, v3(1, 2, 3), v3(0, -1, -2)],
    ["math.mul", "vec3", "float", v3(1, 2, 3), 2, v3(2, 4, 6)],
    ["math.mul", "float", "vec3", 2, v3(1, 2, 3), v3(2, 4, 6)],
    ["math.mul", "vec3", "int", v3(1, 2, 3), 3, v3(3, 6, 9)],
    ["math.div", "vec3", "float", v3(2, 4, 6), 2, v3(1, 2, 3)],
    ["math.div", "vec3", "float", v3(2, 4, 6), 0, v3(0, 0, 0)],
    ["math.div", "float", "vec3", 6, v3(1, 0, 3), v3(6, 0, 2)],
    ["math.add", "vec2", "vec2", v2(1, 2), v2(3, 4), v2(4, 6)],
    ["math.div", "vec2", "float", v2(3, 6), 3, v2(1, 2)],
    ["math.sub", "float", "vec2", 5, v2(1, 2), v2(4, 3)],
    ["math.mul", "vec4", "vec4", v4(1, 2, 3, 4), v4(2, 2, 2, 2), v4(2, 4, 6, 8)],
    ["math.mul", "int", "vec4", 2, v4(1, 2, 3, 4), v4(2, 4, 6, 8)],
    ["math.div", "vec4", "vec4", v4(8, 4, 2, 1), v4(2, 0, 2, 0), v4(4, 0, 1, 0)],
  ] as const)("%s of %s and %s: %j and %j is %j", (typeId, aType, bType, a, b, expected) => {
    expect(run(typeId, { aType, bType, "default:a": a, "default:b": b })).toEqual(expected);
  });

  it.each([
    ["int", 3, -3],
    ["float", -1.5, 1.5],
    ["vec2", v2(1, -2), v2(-1, 2)],
    ["vec3", v3(1, -2, 3), v3(-1, 2, -3)],
    ["vec4", v4(1, -2, 3, -4), v4(-1, 2, -3, 4)],
  ] as const)("Negate of a %s %j is %j", (inType, value, expected) => {
    expect(run("math.negate", { inType, "default:in": value })).toEqual(expected);
  });

  it("calls one shared helper per operation, axes and number side", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("left", "math.div", { aType: "vec3", bType: "float" }),
        node("right", "math.div", { aType: "vec3", bType: "float" }),
        node("flipped", "math.div", { aType: "float", bType: "vec3" }),
        node("log1", "debug.log"), node("log2", "debug.log"), node("log3", "debug.log"),
      ],
      edges: [
        { id: "x1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log1", targetPinId: "execIn" },
        { id: "x2", sourceNodeId: "log1", sourcePinId: "execOut", targetNodeId: "log2", targetPinId: "execIn" },
        { id: "x3", sourceNodeId: "log2", sourcePinId: "execOut", targetNodeId: "log3", targetPinId: "execIn" },
        { id: "d1", sourceNodeId: "left", sourcePinId: "out", targetNodeId: "log1", targetPinId: "message" },
        { id: "d2", sourceNodeId: "right", sourcePinId: "out", targetNodeId: "log2", targetPinId: "message" },
        { id: "d3", sourceNodeId: "flipped", sourcePinId: "out", targetNodeId: "log3", targetPinId: "message" },
      ],
    };
    const source = compileGraph(graph, { assetGuid: "a", registry }).source;
    // The emitted helpers are the contract here: equal operations share one declaration.
    expect(source.match(/var __vec_divScalar_xyz =/g)).toHaveLength(1);
    expect(source.match(/var __vec_scalarDiv_xyz =/g)).toHaveLength(1);
  });
});

describe("invalid operand types", () => {
  it.each([
    ["math.add", { aType: "vec2", bType: "vec3" }],
    ["math.mod", { aType: "vec3", bType: "float" }],
  ] as const)("%s with %o reports a diagnostic and refuses to compile", (typeId, properties) => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [node("begin", "flow.event.beginPlay"), node("op", typeId, properties), node("log", "debug.log")],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "op", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    expect(validateGraphs([graph], { assetGuid: "a" }).filter((d) => d.code === "math.operandTypes")).toEqual([
      expect.objectContaining({ severity: "error", nodeId: "op" }),
    ]);
    expect(() => compileGraph(graph, { assetGuid: "a", registry })).toThrow(/cannot combine/);
  });

  it("reports nothing for valid operands", () => {
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [node("op", "math.add", { aType: "vec3", bType: "int" })], edges: [] };
    expect(validateGraphs([graph], { assetGuid: "a" }).filter((d) => d.code === "math.operandTypes")).toEqual([]);
  });
});

describe("retypeNumericOperands", () => {
  const unwired = { wired: false };
  const wire = (type?: NumericOperandType) => ({ wired: true, type });
  const links = (map: Record<string, { wired: boolean; type?: NumericOperandType }>) => (pinId: string) => map[pinId] ?? unwired;

  it("takes a wired operand's type and drops its stored value of the old type", () => {
    expect(retypeNumericOperands("math.mul", { aType: "vec3", bType: "vec3", "default:a": v3(1, 1, 1), "default:b": v3(2, 2, 2) },
      links({ a: wire("vec3"), b: wire("float") }))).toEqual({ aType: "vec3", bType: "float", "default:a": v3(1, 1, 1) });
  });

  it("brings an untouched, valueless operand of the same old type along", () => {
    expect(retypeNumericOperands("math.add", {}, links({ a: wire("vec3") }))).toEqual({ aType: "vec3", bType: "vec3" });
    expect(retypeNumericOperands("math.add", {}, links({ b: wire("int") }))).toEqual({ aType: "int", bType: "int" });
  });

  it("leaves the other operand when it has a value, a wire or another type", () => {
    expect(retypeNumericOperands("math.mul", { "default:b": 2 }, links({ a: wire("vec3") }))).toEqual({ aType: "vec3", "default:b": 2 });
    expect(retypeNumericOperands("math.mul", {}, links({ a: wire("vec3"), b: wire() }))).toEqual({ aType: "vec3" });
    expect(retypeNumericOperands("math.mul", { bType: "int" }, links({ a: wire("vec3") }))).toEqual({ aType: "vec3", bType: "int" });
  });

  it("returns the same object when the types already match or a wire has no number type", () => {
    const typed = { aType: "vec3", bType: "vec3", "default:b": v3(1, 2, 3) };
    expect(retypeNumericOperands("math.add", typed, links({ a: wire("vec3") }))).toBe(typed);
    const plain = { "default:a": 1 };
    expect(retypeNumericOperands("math.add", plain, links({ a: wire(undefined) }))).toBe(plain);
    // An unwired operand keeps its type once its wire is gone.
    expect(retypeNumericOperands("math.add", typed, links({}))).toBe(typed);
  });

  it("never gives Modulo a vector and retypes Negate's one operand", () => {
    const mod = { aType: "float" };
    expect(retypeNumericOperands("math.mod", mod, links({ a: wire("vec3") }))).toBe(mod);
    expect(retypeNumericOperands("math.negate", { "default:in": 2 }, links({ in: wire("vec2") }))).toEqual({ inType: "vec2" });
  });
});
