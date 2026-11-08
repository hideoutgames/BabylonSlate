import { describe, expect, it } from "vitest";
import {
  ENGINE_SEED_STRUCT_ID,
  ENGINE_STRUCTS,
  validateGraphs,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();
const SEED_FIELDS = ENGINE_STRUCTS.find((entry) => entry.id === ENGINE_SEED_STRUCT_ID)!.fields;
const BY_REF_SEED = { name: "Seed", typeId: "struct", typeClassId: ENGINE_SEED_STRUCT_ID, direction: "in", byReference: true };
const PINS = [{ name: "exec", typeId: "exec", direction: "in" }, { name: "then", typeId: "exec", direction: "out" }, BY_REF_SEED];

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties };
}

function edge(source: string, sourcePin: string, target: string, targetPin: string): GraphEdge {
  return { id: `${source}.${sourcePin}->${target}.${targetPin}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin };
}

function referenceErrors(graph: LogicGraph): string[] {
  return validateGraphs([graph], { assetGuid: "dice" }, { registry })
    .filter((entry) => entry.severity === "error" && (entry.code === "pin.invalid_reference" || entry.code === "pin.missing_input"))
    .map((entry) => `${entry.nodeId}.${entry.pinId}:${entry.code}`);
}

const seedVariable = () => node("seed", "variables.get", { variableName: "Seed", typeId: "struct", typeClassId: ENGINE_SEED_STRUCT_ID, implicitSelf: true });
const madeSeed = () => node("made", "struct.make", { structGuid: ENGINE_SEED_STRUCT_ID, fields: SEED_FIELDS });

describe("By-reference Seed inputs", () => {
  it("take a writable Seed variable or a Pass-By-Reference input, never a value", () => {
    // Validation checks what runs: the function's Input starts the chain that prints the roll.
    const graph = (source: string, sourcePin: string, pins = PINS, extra: GraphNode[] = []): LogicGraph => ({
      id: "Roll", kind: "function",
      nodes: [node("input", "flow.function.input", { pins }), ...extra, node("roll", "random.seededFloat"), node("print", "debug.print")],
      edges: [edge("input", "exec", "print", "execIn"), edge(source, sourcePin, "roll", "seed"), edge("roll", "out", "print", "value")],
    });
    expect(referenceErrors(graph("seed", "value", PINS, [seedVariable()]))).toEqual([]);
    expect(referenceErrors(graph("input", "Seed"))).toEqual([]);
    expect(referenceErrors(graph("made", "out", PINS, [madeSeed()]))).toEqual(["roll.seed:pin.invalid_reference"]);
    // A pass-by-value input is a value too.
    const byValue = PINS.map((row) => ({ ...row, byReference: undefined }));
    expect(referenceErrors(graph("input", "Seed", byValue))).toEqual(["roll.seed:pin.invalid_reference"]);
    const unwired = graph("input", "Seed");
    unwired.edges = unwired.edges.filter((entry) => entry.targetPinId !== "seed");
    expect(referenceErrors(unwired)).toEqual(["roll.seed:pin.missing_input"]);
  });

  it("make a Pass-By-Reference Call argument and Set By-Ref Var's Target need a variable of any type", () => {
    const call = (source: GraphNode, sourcePin: string): LogicGraph => ({
      id: "event", kind: "event",
      nodes: [node("begin", "flow.event.beginPlay"), source,
        node("call", "functions.call", { functionName: "RollWith", classId: "Dice", implicitSelf: true, pins: PINS })],
      edges: [edge("begin", "execOut", "call", "exec"), edge(source.id, sourcePin, "call", "Seed")],
    });
    expect(referenceErrors(call(seedVariable(), "value"))).toEqual([]);
    expect(referenceErrors(call(madeSeed(), "out"))).toEqual(["call.Seed:pin.invalid_reference"]);

    const set = (source: GraphNode, sourcePin: string): LogicGraph => ({
      id: "event", kind: "event",
      nodes: [node("begin", "flow.event.beginPlay"), source, node("value", "literal.makeInt"), node("set", "variables.setByRef")],
      edges: [edge("begin", "execOut", "set", "execIn"), edge(source.id, sourcePin, "set", "target"), edge("value", "out", "set", "value")],
    });
    expect(referenceErrors(set(node("hits", "variables.get", { variableName: "Hits", typeId: "int", implicitSelf: true }), "value"))).toEqual([]);
    expect(referenceErrors(set(node("literal", "literal.makeInt"), "out"))).toEqual(["set.target:pin.invalid_reference"]);
  });
});
